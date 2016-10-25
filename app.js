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
    redisClient = redis.createClient({host: 'dev.alol.io'});
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


var clients = {};
var requestQueueName = config.get('request_queue_name');
var responseQueueName = config.get('response_queues_name');

var chanel;
var calls = {};
var users = {};
var socketMap = {};


sStore = {
    userSocket: {},
    socketUser: {},
    addSocketUser: function (socketId, userId) {
        this.socketUser[socketId] = userId;
    },
    addSocket: function (userId, socketId) {
        this.userSocket[userId][socketId] = socketId;
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
            socketId = calls[msg.properties.correlationId];
            clients[socketId].emit('response', msg.content.toString());
            delete calls[msg.properties.correlationId];
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
    console.log(cookies);
    /*    if (!cookies.sid) {
     console.log('Cookie is absent', cookies);
     next(new Error('not authorized'));
     return;
     }*/
    cookies.sid = '2l81os6eeug9isr7nc6b9be8v2';
    sid = 'PHPREDIS_SESSION:' + cookies.sid;
    redisClient.get(sid, function (err, reply) { // get entire file
        if (err || reply == null) {
            console.log('redis get error: ', sid);
            next(new Error('not authorized'));
        } else {
            session = PHPUnserialize.unserializeSession(reply);
            if (!session.user_id || session.user_id == 0) {
                next(new Error('not authorized'));
                return;
            }
            console.log('success auth', sid, reply);
            if (!users[session.user_id]) {
                users[session.user_id] = {};
            }
            console.log(session);
            users[session.user_id][socket.id] = socket.id;

            if (!socketMap[socket.id]) {
                socketMap = [];
            }
            socketMap[socket.id] = session.user_id;
            console.log(users, socketMap);
            next();
        }
    });
});


io.on('connection', function (socket) {
    console.info('New client connected (id=' + socket.id + ').');
    clients[socket.id] = socket;
    socket.join('user_id');

    socket.on('disconnect', function () {
        delete clients[socket.id];
        userId = socketMap[socket.id];
        delete socketMap[socket.id];
        delete users[userId][socket.id];
        console.info('Client gone (id=' + socket.id + ').');

    });

    socket.on('request', function (data) {
        console.log(data);
        var corr = uuid();
        calls[corr] = socket.id;
        console.log(calls);
        chanel.sendToQueue(requestQueueName,
            new Buffer(JSON.stringify(data)),
            {correlationId: corr, replyTo: config.get('response_queues_name')});
    });
    socket.on('check', function (data) {
        clients[socket.id].emit('check', data);
    });
});