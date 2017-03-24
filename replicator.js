const amqplibup = require('amqplibup');
const config = require('./config');
const EventEmitter = require('events');
const fs = require('fs');
const levelup = require('levelup');
const Promise = require('bluebird');
const promisifyStreamChunks = require('promisify-stream-chunks');
const request = require('request');
const split = require('split');

const bytepos = 0;
const index = [];

class IncomingEmitter extends EventEmitter {}
const incomingEmitter = new IncomingEmitter();

let highestPosition = -1;

let logger = { log: () => { } };
if (process.env.DEBUG) logger = console;

const storage = '/tmp/eventreplicator';
const init = new Promise((resolve, reject) => {

	levelup(
		storage,
		{
			keyEncoding: 'utf8',
			valueEncoding: 'json',
			sync: false
		},
		(err, db) => {

			if (err) return reject(err);

			function addToDb(data, callback) {

				logger.log('addtoDb(' + JSON.stringify(data) + ')');

				db.put(
					data.pos + '',
					data,
					{
						keyEncoding: 'utf8',
						valueEncoding: 'json',
						sync: false
					},
					err => {
						if (!err) {
							logger.log('Emit new data to internal incoming emitter!');
							incomingEmitter.emit(data.pos + '', data);
							if (data.pos > highestPosition) {
								logger.log('highestPosition:', highestPosition, '-->', data.pos);
								highestPosition = data.pos;
							}
						}
						callback(err);
					}
				);
			}

			let firstConnect = true;
			function fetchHttpHistory() {
				let error = false;
				request(config.historyUrl)
				.on('error', err => {
					error = err;
					setTimeout(fetchHttpHistory, 2000);
				})
				.pipe(split(JSON.parse, null, { trailing: false }))
				.pipe(promisifyStreamChunks(chunk => {
					
					return new Promise((resolve, reject) => {

						addToDb(
							chunk,
							err => {
								if (err) return reject(err);
								resolve();
							}
						);

					});

				}))
				.on('finish', () => {
					if (!error) resolve(db);
				});
			}

			amqplibup('amqp://' + config.amqpHost, conn => {
				conn.createChannel((err, ch) => {
					connection = conn;
					channel = ch;
					channel.assertQueue('', { exclusive: true }, (err, q) => {
						queue = q.queue;
						channel.assertExchange(config.exchangeName, 'fanout', { durable: true })
						channel.bindQueue(queue, config.exchangeName, ''); // Bind to events exchange.

						if (firstConnect) {
							// We should have a binded queue before we start
							// to fetch the http history, to avoid glitches.
							fetchHttpHistory();
							firstConnect = false;
						}

						channel.consume(queue, msg => {
							if (msg !== null) {
								let content;
								try {
									content = JSON.parse(msg.content.toString());
								} catch (err) {
									channel.ack(msg);
									return;
								}

								addToDb(
									content,
									err => {
										if (err) {
											console.error('Unhandled error:', err);
										}
										channel.ack(msg);
									}
								);
							}
						});
					});
				});
			});
		}
	);
});

function getPosition(position) {
	logger.log('replicator', 'getPosition(' + position + ')');
	return init
	.then(db => {
		return new Promise((resolve, reject) => {
			
			let listener; 
			if (position > highestPosition) {
				listener = data => {
					logger.log('replicator', 'getPosition(' + position + ') was resolved with value:', JSON.stringify(data));
					resolve(data);
				};
				incomingEmitter.once(position + '', listener);
				logger.log('replicator', 'added internal listener for position', position);
			}

			db.get(
				position + '',
				{
					fillCache: false,
					keyEncoding: 'utf8',
					valueEncoding: 'json',
				},
				(err, value) => {
					if (err) {
						logger.log('replicator', 'did not find position in database.');
						// Don't do anything. We have a listener waiting for
						// the position to be emitted!
						return;
					}
					logger.log('replicator', 'found position in database.');
					if (typeof listener !== 'undefined') {
						logger.log('repliator', 'removed internal listener for position', position);
						incomingEmitter.removeListener(position + '', listener);
					}
					logger.log('replicator', 'getPosition(' + position + ') was resolved with value:', JSON.stringify(value));
					resolve(value);
				}
			);
		});
	});
}

module.exports = {
	getPosition
};

