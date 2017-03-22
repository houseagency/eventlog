const expect = require('chai').expect;

describe('Unit:', () => {

	const td = require('testdouble');

});

describe('Integration:', () => {

	const amqp = require('amqplibup');
	const command = require('../command');
	const http = require('http');
	const listener = require('../listener');
	const randStr = () => (new Date()).getTime().toString(36) + Math.random().toString(36).substring(7);

	let channel;

	before(function(done) {
		this.timeout(10000);
		amqp('amqp://rabbitmq', conn => {
			conn.createChannel((err, ch) => {
				if (err) return done(err);
				ch.assertQueue('events', { durable: true });
				if (typeof channel === 'undefined') {
					setImmediate(done); // Done should only be callend once.
				}
				channel = ch;
			});
		});
	});

	describe('Server', () => {
		
		it('will respond with the position number', function(done) {
			this.timeout(10000);
			let replyQueue = 'reply' + randStr();
			let correlationId = randStr();
			channel.assertQueue(replyQueue, { durable: false });
			channel.consume(replyQueue, function(msg) {
				if (msg !== null) {
					let content = msg.content.toString();
					expect(msg.properties.correlationId).to.equal(correlationId);
					expect(content).to.equal('0');
					done();
				}
				channel.ack(msg);
			});
			channel.sendToQueue(
				'events',
				new Buffer(JSON.stringify({ test: 'test' })),
				{ correlationId: correlationId, replyTo: replyQueue }
			);
		});

		it('next message should have increased the position number', function(done) {
			let replyQueue = 'reply' + randStr();
			let correlationId = randStr();
			channel.assertQueue(replyQueue, { durable: false });
			channel.consume(replyQueue, function(msg) {
				if (msg !== null) {
					let content = msg.content.toString();
					expect(msg.properties.correlationId).to.equal(correlationId);
					expect(content).to.equal('1');
					done();
				}
				channel.ack(msg);
			});
			channel.sendToQueue(
				'events',
				new Buffer(JSON.stringify({ test: 'test' })),
				{ correlationId: correlationId, replyTo: replyQueue }
			);
		});

		it('broken message should not get a position number', function(done) {
			let replyQueue = 'reply' + randStr();
			let correlationId = randStr();
			channel.assertQueue(replyQueue, { durable: false });
			channel.consume(replyQueue, function(msg) {
				if (msg !== null) {
					let content = msg.content.toString();
					expect(msg.properties.correlationId).to.equal(correlationId);
					expect(content).to.equal('-1');
					done();
				}
				channel.ack(msg);
			});
			channel.sendToQueue(
				'events',
				new Buffer('{ invalid json'),
				{ correlationId: correlationId, replyTo: replyQueue }
			);
		});

		it('position numbering should not fuck up because of previous error', function(done) {
			let replyQueue = 'reply' + randStr();
			let correlationId = randStr();
			channel.assertQueue(replyQueue, { durable: false });
			channel.consume(replyQueue, function(msg) {
				if (msg !== null) {
					let content = msg.content.toString();
					expect(msg.properties.correlationId).to.equal(correlationId);
					expect(content).to.equal('2');
					done();
					channel.ack(msg);
				}
			});
			channel.sendToQueue(
				'events',
				new Buffer(JSON.stringify({ test: 'test' })),
				{ correlationId: correlationId, replyTo: replyQueue }
			);
		});

		it('entire event history should be accessible over http', function(done) {
			http.get('http://eventstore/', res => {
				let rawData = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => rawData += chunk);
				res.on('end', () => {
					let data = rawData.split("\n");
					expect(data.length).to.equal(4);
					var dataObj = [
						JSON.parse(data[0]),
						JSON.parse(data[1]),
						JSON.parse(data[2])
					];
					expect(Object.keys(dataObj[0])).to.deep.equal(['pos', 'time', 'event']);
					expect(Object.keys(dataObj[1])).to.deep.equal(['pos', 'time', 'event']);
					expect(Object.keys(dataObj[2])).to.deep.equal(['pos', 'time', 'event']);
					expect(dataObj[0].pos).to.equal(0);
					expect(dataObj[1].pos).to.equal(1);
					expect(dataObj[2].pos).to.equal(2);
					expect(dataObj[0].event).to.deep.equal({test: 'test'});
					expect(dataObj[1].event).to.deep.equal({test: 'test'});
					expect(dataObj[2].event).to.deep.equal({test: 'test'});
					expect(data[3]).to.equal(''); // File ends with linebreak
					done();
				});
			});
		});

		it('events should be re-broadcasted to fanout exchange', function(done) {
			this.timeout(10000);

			let correlationId = randStr();

			channel.assertQueue('', { exclusive: true }, (err, q) => {
				channel.bindQueue(q.queue, 'events', ''); // Bind to events exchange.
				channel.consume(q.queue, msg => {
					if (msg !== null) {
						let content = JSON.parse(msg.content.toString());
						expect(msg.properties.correlationId).to.equal(correlationId);
						expect(content.pos).to.equal(3);
						expect(content.event.test).to.equal('alfred was here');
						channel.ack(msg);

						// Stop more messages from this queue.
						channel.cancel(msg.fields.consumerTag, () => {
							done();
						});
					}
				});
				channel.sendToQueue(
					'events',
					new Buffer(JSON.stringify({ test: 'alfred was here' })),
					{ correlationId: correlationId }
				);

			});

		});

	});

	describe('command', () => {

		describe('add', () => {

			it('event should end up in the fanout exchange', function(done) {
				this.timeout(10000);

				channel.assertQueue('', { exclusive: true }, (err, q) => {
					channel.bindQueue(q.queue, 'events', ''); // Bind to events exchange.
					channel.consume(q.queue, msg => {
						if (msg !== null) {
							let content = JSON.parse(msg.content.toString());

							expect(content.pos).to.equal(4);
							expect(content.event.test).to.equal('the command add');
							channel.ack(msg);
							//
							// Stop more messages from this queue.
							channel.cancel(msg.fields.consumerTag, () => {
								done();
							});
						}
					});
					command.add({ test: 'the command add' })
					.then(() => {
					});
				});
			});

			it('add command shall return the position number', function(done) {
				this.timeout(10000);

				channel.assertQueue('', { exclusive: true }, (err, q) => {
					channel.bindQueue(q.queue, 'events', ''); // Bind to events exchange.
					channel.consume(q.queue, msg => {
						if (msg !== null) {
							let content = JSON.parse(msg.content.toString());

							expect(content.pos).to.equal(4);
							expect(content.event.test).to.equal('the command add');
							channel.ack(msg);
							//
							// Stop more messages from this queue.
							channel.cancel(msg.fields.consumerTag, () => {
							});
						}
					});
					command.add({ test: 'the command add' })
					.then(pos => {
						expect(pos).to.be.a('number');
						done();
					});
				});
			});

		});

	});

	describe('listener', () => {

		describe('listen()', () => {

			it('can get all history', function (done) {

				let msgs = [];
				listener.listen(0, msg => {
					return new Promise((resolve, reject) => {
						msgs.push(msg);
						if (msg.pos === 5) {
							setTimeout(() => {
								expect(msgs.length).to.equal(6);
								expect(msgs[0].pos).to.equal(0);
								expect(msgs[1].pos).to.equal(1);
								expect(msgs[2].pos).to.equal(2);
								expect(msgs[3].pos).to.equal(3);
								expect(msgs[4].pos).to.equal(4);
								expect(msgs[5].pos).to.equal(5);
								done();
							}, 250);
						}
						resolve();
					});
				});

			});

			it('gets new events after history was read', function (done) {

				let msgs = [];
				listener.listen(0, msg => {
					return new Promise((resolve, reject) => {
						msgs.push(msg);
						if (msg.pos === 5) {
							setTimeout(() => {
								command.add({ test: 'added pos 6' })
								.then(() => {
								})
								.catch(err => {
								});
							}, 250);
						}
						if (msg.pos === 6) {
							expect(msgs.length).to.equal(7);
							expect(msgs[6].event.test).to.equal('added pos 6');
							done();
						} else {
						}
						resolve();
					});
				});

			});

		});

	});

});
