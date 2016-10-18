var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var when = require('when');
var server = require('http').createServer(app);
var io = require('socket.io')(server, {'transports': ['websocket', 'polling']});
var amqp = require('amqplib/callback_api');
var uuid = require('node-uuid');
var config = require('config');

server.listen(config.get('port'), config.get('host'));


app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());
app.get('/', function (req, res, next) {
    res.sendFile(__dirname + '/index.html');
});
var clients = {};
var requestQueueName = config.get('request_queue_name');
var responseQueueName = config.get('response_queues_name');

var chanel;
var calls = {};

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
        chanel.assertQueue(responseQueueName, {exclusive: true, autoDelete: true, durable: false});
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

io.on('connection', function (socket) {
    console.info('New client connected (id=' + socket.id + ').');
    clients[socket.id] = socket;
    socket.join('user_id');

    socket.on('disconnect', function () {
        delete clients[socket.id];
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