var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var PHPUnserialize = require('php-unserialize');
var server = require('http').createServer(app);
var io = require('socket.io')(server, {'transports': ['websocket']});
var amqp = require('amqplib/callback_api');
var uuid = require('node-uuid');
var config = require('config');
var redis = require("redis"),
    redisClient = redis.createClient({host: config.get('redis_host'), port: config.get('redis_port')});
var cookie = require('cookie');

var winston = require('winston');
var logger = new winston.Logger({
    level: config.get('logger_level'),
    transports: []
});

if (config.get('logger_file')) {
    logger.add(winston.transports.File,{filename: config.get('logger_file')});
}
if (config.get('logger_console')) {
    logger.add(winston.transports.Console);
}
if (config.get('logger_graylog')) {
    logger.add(require('winston-graylog2'), {
        name: 'Graylog',
        level: 'debug',
        silent: false,
        handleExceptions: false,
        prelog: function(msg) {
            return msg.trim();
        },
        graylog: {
            servers: [{host: 'graylog', port: 12201}],
            hostname: 'myServer',
            facility: 'websocket',
            bufferSize: 1400
        },
        staticMeta: {env: 'websocket'}
    });
}

server.listen(config.get('port'), config.get('host'));
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());
app.get('/', function (req, res, next) {
    res.sendFile(__dirname + '/index.html');
});


redisClient.on("error", function (err) {
    logger.log('error', "[redis] " + err);
});

var requestQueueName = config.get('request_queue_name');
var responseQueueName = null;
var eventQueueName = config.get('event_queues_name');

var chanel;


sStore = {
    sockets: {},
    userSockets: {},
    socketUsers: {},
    requesrs: {},
    socketSession: {},
    sessionSocket: {},
    addSocketUser: function (socketId, userId) {
        this.socketUsers[socketId] = userId;
    },
    addUserSocket: function (userId, socketId) {
        if (!this.userSockets[userId]) {
            this.userSockets[userId] = {};
        }
        this.userSockets[userId][socketId] = socketId;
    },
    findUserSocket: function (userId) {
        if (this.userSockets[userId]) {
            return this.userSockets[userId];
        }
        return {}
    },
    addSocket: function (socket) {
        this.sockets[socket.id] = socket;
    },
    getSocket: function (socketId) {
        return this.sockets[socketId];
    },
    deleteSocket: function (socketId) {
        userId = this.socketUsers[socketId];
        delete this.socketUsers[socketId];
        delete this.userSockets[userId][socketId];
        delete this.sockets[socketId];
        delete this.sessionSocket[this.socketSession[socketId]];
        delete this.socketSession[socketId];
    },
    addRequest: function (requestId, socketId) {
        this.requesrs[requestId] = socketId;
        logger.log('debug', 'add request to socket ' + requestId + ' to ' + socketId);
    },
    getSocketByRequestId: function (requestId) {
        socketId = this.requesrs[requestId];
        delete this.requesrs[requestId];
        return this.sockets[socketId];
    },
    addSocketSession: function (socketId, sid) {
        this.socketSession[socketId] = sid;
        this.sessionSocket[sid] = socketId;
    },
    getSocketSession: function (socketId) {
        return this.socketSession[socketId];
    },
    getSessionSocket: function (sid) {
        return this.sessionSocket[sid];
    }
};


amqpConnect = function (err, conn) {
    if (err !== null) {
        logger.log('error', "[AMQP] " + err.message);
        return setTimeout(start, 1000);
    }

    conn.on("error", function (err) {
        if (err.message !== "Connection closing") {
            logger.log('error', "[AMQP] Conn error" + err.message);
        }
    });
    conn.on("close", function () {
        logger.log('error', "[AMQP] reconnecting");
        return setTimeout(start, 1000);
    });

    conn.createChannel(function (err, ch) {
        logger.log('info', "[AMQP] connected");
        ch.assertExchange(eventQueueName, 'fanout', {durable: false});
        ch.assertQueue('', {exclusive: true}, function(err, q){
            ch.bindQueue(q.queue, eventQueueName, '');
            ch.consume(q.queue, function (msg) {
                var event = JSON.parse(msg.content.toString());
                logger.log('debug', 'event' + event);
                if (event.type == 'session_close') {
                    var socketId = sStore.getSessionSocket(event.data.sid);
                    if (!socketId) {
                        return;
                    }
                    var socket = sStore.getSocket(socketId);
                    socket.emit('event', event);
                    socket.disconnect('session has been closed');
                    sStore.deleteSocket(socketId)
                    logger.log('info', 'Client gone (id=' + socket.id + ').');
                }
                else {
                    var sockets = sStore.findUserSocket(event.user_id);
                    for (var socketId in sockets) {
                        sStore.getSocket(socketId).emit('event', event);
                    }
                }
            }, {noAck: true});
        });
    });

    conn.createChannel(function (err, ch) {
        logger.log('info', "[AMQP] connected");
        chanel = ch;
        ch.assertQueue('', {exclusive: true}, function(err, q) {
            responseQueueName = q.queue;
            chanel.consume(q.queue, function (msg) {
                response = msg.content.toString();
                sStore.getSocketByRequestId(msg.properties.correlationId).emit('response', response);
                logger.log('debug', '[RESPONSE] ' + response);
            }, {noAck: true});
        });

    });

};

start = function () {
    amqp.connect(config.get('rabbit'), amqpConnect);
}

start();

io.use(function (socket, next) {
    if (socket.request.headers.cookie === undefined) {
        next(new Error('not authorized 1 ' + JSON.stringify(socket.request.headers)));
        socket.disconnect();
        return;
    }
    var cookies = cookie.parse(socket.request.headers.cookie);
    //cookies.sid = '8bd5500183457d6ff2c8ef4c7c3e0fdf';
    sid = 'PHPREDIS_SESSION:' + cookies.sid;
    redisClient.get(sid, function (err, reply) { // get entire file
        if (err || !reply) {
            logger.log('error', 'redis get error: ' + cookies.sid);
            next(new Error('not authorized 2 ' + JSON.stringify(socket.request.headers)));
            socket.disconnect();
        } else {
            session = PHPUnserialize.unserializeSession(reply);
            if (!session.__id || session.__id == 0) {
                next(new Error('not authorized 3 ' + JSON.stringify(socket.request.headers)));
                socket.disconnect();
                return;
            }
            logger.log('info', 'success auth ' + sid + ' ' + reply);
            sStore.addUserSocket(session.__id, socket.id);
            sStore.addSocketUser(socket.id, session.__id);
            sStore.addSocketSession(socket.id, cookies.sid)
            next();
        }
    });
});


io.on('connection', function (socket) {
    logger.log('info', 'New client connected (id=' + socket.id + ').');
    sStore.addSocket(socket);
    socket.on('disconnect', function () {
        sStore.deleteSocket(socket.id);
        logger.log('info', 'Client gone (id=' + socket.id + ').');
    });

    socket.on('request', function (data) {
        logger.log('debug', '[REQUEST] ' + JSON.stringify(data));
        var corr = uuid();
        sStore.addRequest(corr, socket.id);
        data.sid = sStore.getSocketSession(socket.id);
        chanel.sendToQueue(requestQueueName,
            new Buffer(JSON.stringify(data)),
            {correlationId: corr, replyTo: responseQueueName});
    });
    socket.on('check', function (data) {
        sStore.getSocket(socket.id).emit('check', data);
    });
});