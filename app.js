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
    redisClient = redis.createClient({host: 'redis', port: 9379});
var cookie = require('cookie');


server.listen(config.get('port'), config.get('host'));
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());
app.get('/', function (req, res, next) {
    res.sendFile(__dirname + '/index.html');
});


redisClient.on("error", function (err) {
    console.log("Error " + err);
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
    deleteSocket:function(socketId){
        userId = this.socketUsers[socketId];
        delete this.socketUsers[socketId];
        delete this.userSockets[userId][socketId];
        delete this.sockets[socketId];
    },
    addRequest: function (requestId, socketId) {
        this.requesrs[requestId] = socketId;
        console.log('add request to socket', requestId, socketId);
    },
    getSocketByRequestId: function (requestId) {
        socketId = this.requesrs[requestId];
        delete this.requesrs[requestId];
        return this.sockets[socketId];

    }
};


amqpConnect = function (err, conn) {
    if (err !== null) {
        console.error("[AMQP]", err.message);
        return setTimeout(start, 1000);
    }

    conn.on("error", function (err) {
        if (err.message !== "Connection closing") {
            console.error("[AMQP] conn error", err.message);
        }
    });
    conn.on("close", function () {
        console.error("[AMQP] reconnecting");
        return setTimeout(start, 1000);
    });
    conn.createChannel(function (err, ch) {
        console.log("[AMQP] connected");
        chanel = ch;
        chanel.assertQueue(responseQueueName, {exclusive: false, autoDelete: false, durable: true});
        chanel.consume(responseQueueName, function (msg) {
            sStore.getSocketByRequestId(msg.properties.correlationId).emit('response', msg.content.toString());
        }, {noAck: true});

        chanel.assertQueue(eventQueueName, {exclusive: false, autoDelete: false, durable: true});
        chanel.consume(eventQueueName, function (msg) {
            var event = JSON.parse(msg.content.toString());
            console.log('event', event);
            var sockets = sStore.findUserSocket(event.user_id);
            console.log(sockets);
            for(var socketId in sockets) {
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
        next(new Error('not authorized'));
        return;
    }
    var cookies = cookie.parse(socket.request.headers.cookie);
    //cookies.sid = '8bd5500183457d6ff2c8ef4c7c3e0fdf';
    sid = 'PHPREDIS_SESSION:' + cookies.sid;
    redisClient.get(sid, function (err, reply) { // get entire file
        if (err || !reply) {
            console.log('redis get error: ', cookies);
            next(new Error('not authorized'));
        } else {
            session = PHPUnserialize.unserializeSession(reply);
            if (!session.__id || session.__id == 0) {
                next(new Error('not authorized'));
                return;
            }
            console.log('success auth', sid, reply, session);
            sStore.addUserSocket(session.__id, socket.id);
            sStore.addSocketUser(socket.id, session.__id);
            next();
        }
    });
});


io.on('connection', function (socket) {
    console.info('New client connected (id=' + socket.id + ').');
    sStore.addSocket(socket);
    socket.on('disconnect', function () {
        sStore.deleteSocket(socket.id);
        console.info('Client gone (id=' + socket.id + ').');
    });

    socket.on('request', function (data) {
        console.log(data);
        var corr = uuid();
        sStore.addRequest(corr, socket.id);
        chanel.sendToQueue(requestQueueName,
            new Buffer(JSON.stringify(data)),
            {correlationId: corr, replyTo: config.get('response_queues_name')});
    });
    socket.on('check', function (data) {
        sStore.getSocket(socket.id).emit('check', data);
    });
});