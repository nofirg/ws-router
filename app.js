var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var PHPUnserialize = require('php-unserialize');
var server = require('http').createServer(app);
var io = require('socket.io')(server, {'transports': ['websocket', 'polling']});
var amqp = require('amqplib/callback_api');
var uuid = require('node-uuid');
var config = require('config');
var redis = require("redis"),
    redisClient = redis.createClient({host: config.get('redis_host'), port: config.get('redis_port')});
var cookie = require('cookie');

var winston = require('winston');
var logger = new winston.Logger({
    level: 'debug',
    transports: [
        new (winston.transports.Console)(),
        new (winston.transports.File)({ filename: '/app/log/websocket.log' })
    ]
});


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
var responseQueueName = config.get('response_queues_name');
var eventQueueName = config.get('event_queues_name');

var chanel;


sStore = {
    sockets: {},
    userSockets: {},
    socketUsers: {},
    requesrs: {},
    socketSession: {},
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
        delete this.socketSession[socketId];
    },
    addRequest: function (requestId, socketId) {
        this.requesrs[requestId] = socketId;
        console.log('add request to socket', requestId, socketId);
    },
    getSocketByRequestId: function (requestId) {
        socketId = this.requesrs[requestId];
        delete this.requesrs[requestId];
        return this.sockets[socketId];
    },
    addSocketSession: function (socketId, sid) {
        this.socketSession[socketId] = sid;
    },
    getSocketSession: function (socketId) {
        console.log(this.socketSession);
        return this.socketSession[socketId];
    }
};


amqpConnect = function (err, conn) {
    if (err !== null) {
        logger.log('error', "[AMQP] " + err.message);
        return setTimeout(start, 1000);
    }

    conn.on("error", function (err) {
        if (err.message !== "Connection closing") {
            logger.log('error', "[AMQP] Conn error", err.message);
        }
    });
    conn.on("close", function () {
        logger.log('error', "[AMQP] reconnecting");
        return setTimeout(start, 1000);
    });
    conn.createChannel(function (err, ch) {
        logger.log('info', "[AMQP] connected");
        chanel = ch;
        chanel.assertQueue(responseQueueName, {exclusive: false, autoDelete: false, durable: true});
        chanel.consume(responseQueueName, function (msg) {
            sStore.getSocketByRequestId(msg.properties.correlationId).emit('response', msg.content.toString());
        }, {noAck: true});

        chanel.assertQueue(eventQueueName, {exclusive: false, autoDelete: false, durable: true});
        chanel.consume(eventQueueName, function (msg) {
            var event = JSON.parse(msg.content.toString());
            logger.log('debug', 'event' + event);
            var sockets = sStore.findUserSocket(event.user_id);
            for (var socketId in sockets) {
                sStore.getSocket(socketId).emit('event', event);
            }
        }, {noAck: true});
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
            logger.log('error', 'redis get error: ', cookies);
            next(new Error('not authorized 2 ' + JSON.stringify(socket.request.headers)));
            socket.disconnect();
        } else {
            session = PHPUnserialize.unserializeSession(reply);
            if (!session.__id || session.__id == 0) {
                next(new Error('not authorized 3 ' + JSON.stringify(socket.request.headers)));
                socket.disconnect();
                return;
            }
            logger.log('info', 'success auth ' + sid + ' '  + reply);
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
        logger.log('debug', JSON.stringify(data));
        var corr = uuid();
        sStore.addRequest(corr, socket.id);
        data.sid = sStore.getSocketSession(socket.id);
        chanel.sendToQueue(requestQueueName,
            new Buffer(JSON.stringify(data)),
            {correlationId: corr, replyTo: config.get('response_queues_name')});
    });
    socket.on('check', function (data) {
        sStore.getSocket(socket.id).emit('check', data);
    });
});