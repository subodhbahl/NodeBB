var	RDB = require('./redis.js'),
	utils = require('./../public/src/utils.js'),
	schema = require('./schema.js'),
	user = require('./user.js'),
	topics = require('./topics.js'),
	favourites = require('./favourites.js'),
	threadTools = require('./threadTools.js'),
	postTools = require('./postTools'),
	feed = require('./feed.js'),
	async = require('async'),
	plugins = require('./plugins');

(function(Posts) {

	Posts.minimumPostLength = 8;

	Posts.getPostsByTid = function(tid, start, end, callback) {
		RDB.lrange('tid:' + tid + ':posts', start, end, function(err, pids) {
			
			RDB.handle(err);

			if (pids.length) {
				Posts.getPostsByPids(pids, function(posts) {
					callback(posts);
				});
			} else {
				callback({
					error: 'no-posts'
				});
			}
		});
	}
	
	Posts.addUserInfoToPost = function(post, callback) {
		user.getUserFields(post.uid, ['username', 'userslug', 'reputation', 'postcount', 'picture', 'signature'], function(userData) {

			post.username = userData.username || 'anonymous';
			post.userslug = userData.userslug || '';
			post.user_rep = userData.reputation || 0;
			post.user_postcount = userData.postcount || 0;
			post.picture = userData.picture || require('gravatar').url('', {}, https=global.nconf.get('https'));
			post.signature = postTools.markdownToHTML(userData.signature, true);

			if(post.editor !== '') {
				user.getUserFields(post.editor, ['username', 'userslug'], function(editorData) {
					post.editorname = editorData.username;
					post.editorslug = editorData.userslug;	
					callback();
				});
			} else {
				callback();
			}
		});
	}

	Posts.getPostSummaryByPids = function(pids, callback) {
		
		var returnData = [];
		
		function getPostSummary(pid, callback) {
			Posts.getPostFields(pid, ['pid', 'tid', 'content', 'uid', 'timestamp', 'deleted'], function(postData) {
				Posts.addUserInfoToPost(postData, function() {

					if(postData.deleted !== '1')	{
						returnData.push(postData);
					}
					
					callback(null);
				});
			});
		}
		
		async.eachSeries(pids, getPostSummary, function(err) {
			if(!err) {
				callback(returnData);
			}
		});
	};

	Posts.getPostData = function(pid, callback) {
		RDB.hgetall('post:' + pid, function(err, data) {
			if(err === null) {
				callback(data);
			}
			else
				console.log(err);
		});
	}

	Posts.getPostFields = function(pid, fields, callback) {
		RDB.hmgetObject('post:' + pid, fields, function(err, data) {
			if(err === null) {
				callback(data);
			}
			else {
				console.log(err);
			}
		});		
	}

	Posts.getPostsByPids = function(pids, callback) {
		var posts = [];			

		function iterator(pid, callback) {
			Posts.getPostData(pid, function(postData) {
				if(postData) {
					postData.relativeTime = utils.relativeTime(postData.timestamp);	
					postData.post_rep = postData.reputation;
					postData['edited-class'] = postData.editor !== '' ? '' : 'none';
					postData['relativeEditTime'] = postData.edited !== '0' ? utils.relativeTime(postData.edited) : '';
					
					postData.content = postTools.markdownToHTML(postData.content);

					if(postData.uploadedImages) {
						postData.uploadedImages = JSON.parse(postData.uploadedImages);
					} else {
						postData.uploadedImages = [];
					}
					posts.push(postData);
				}
				callback(null);
			});
		}

		async.eachSeries(pids, iterator, function(err) {
			if(!err) {
				callback(posts);
			} else {
				callback([]);
			}
		});
	}

	Posts.getPostField = function(pid, field, callback) {
		RDB.hget('post:' + pid, field, function(err, data) {
			if(err === null)
				callback(data);
			else
				console.log(err);
		});
	}

	Posts.setPostField = function(pid, field, value) {
		RDB.hset('post:' + pid, field, value);
	}

	Posts.getPostFields = function(pid, fields, callback) {
		RDB.hmget('post:' + pid, fields, function(err, data) {
			if(err === null) {
				var returnData = {};
				
				for(var i=0, ii=fields.length; i<ii; ++i) {
					returnData[fields[i]] = data[i];
				}

				callback(returnData);
			}
			else
				console.log(err);
		});		
	}

	Posts.get_cid_by_pid = function(pid, callback) {
		Posts.getPostField(pid, 'tid', function(tid) {
			if (tid) {
				topics.getTopicField(tid, 'cid', function(cid) {
					if (cid) {
						callback(cid);
					} else {
						callback(false);
					}
				});
			}
		});
	}

	Posts.emitContentTooShortAlert = function(socket) {
		socket.emit('event:alert', {
			type: 'error',
			timeout: 2000,
			title: 'Content too short',
			message: "Please enter a longer post. At least " + Posts.minimumPostLength + " characters.",
			alert_id: 'post_error'
		});
	}

	Posts.reply = function(socket, tid, uid, content, images) {
		if(content) {
			content = content.trim();
		}
		
		if (uid < 1) {
			socket.emit('event:alert', {
				title: 'Reply Unsuccessful',
				message: 'You don&apos;t seem to be logged in, so you cannot reply.',
				type: 'error',
				timeout: 2000
			});
			return;
		} else if (!content || content.length < Posts.minimumPostLength) {
			Posts.emitContentTooShortAlert(socket);
			return;
		}

		user.getUserField(uid, 'lastposttime', function(lastposttime) {

			if(Date.now() - lastposttime < config.post_delay) {
				socket.emit('event:alert', {
					title: 'Too many posts!',
					message: 'You can only post every '+ (config.post_delay / 1000) + ' seconds.',
					type: 'error',
					timeout: 2000
				});
				return;
			}

			Posts.create(uid, tid, content, images, function(postData) {
				if (postData) {
					topics.addPostToTopic(tid, postData.pid);
					
					topics.markUnRead(tid);

					Posts.get_cid_by_pid(postData.pid, function(cid) {
						RDB.del('cid:' + cid + ':read_by_uid', function(err, data) {
							topics.markAsRead(tid, uid);	
						});
					});

					Posts.getTopicPostStats(socket);

					// Send notifications to users who are following this topic
					threadTools.notify_followers(tid, uid);

					socket.emit('event:alert', {
						title: 'Reply Successful',
						message: 'You have successfully replied. Click here to view your reply.',
						type: 'notify',
						timeout: 2000
					});

					postData.content = postTools.markdownToHTML(postData.content);
					postData.post_rep = 0;
					postData.relativeTime = utils.relativeTime(postData.timestamp)
					postData.fav_star_class = 'icon-star-empty';
					postData['edited-class'] = 'none';
					postData.uploadedImages = JSON.parse(postData.uploadedImages);

					var socketData = {
						'posts' : [
							postData
						]
					};
						
					posts.addUserInfoToPost(socketData['posts'][0], function() {
						io.sockets.in('topic_' + tid).emit('event:new_post', socketData);
						io.sockets.in('recent_posts').emit('event:new_post', socketData);
					});					
			
				
				} else {
					socket.emit('event:alert', {
						title: 'Reply Unsuccessful',
						message: 'Your reply could not be posted at this time. Please try again later.',
						type: 'notify',
						timeout: 2000
					});
				}
			});
		});
	};
	
	Posts.create = function(uid, tid, content, images, callback) {
		if (uid === null) {
			callback(null);
			return;
		}
		
		topics.isLocked(tid, function(locked) {
			if (!locked || locked === '0') {
				RDB.incr('global:next_post_id', function(err, pid) {
					RDB.handle(err);

					plugins.fireHook('filter:save_post_content', content, function(content) {
						var timestamp = Date.now(),
							postData = {
								'pid': pid,
								'uid': uid,
								'tid': tid,
								'content': content,
								'timestamp': timestamp,
								'reputation': 0,
								'editor': '',
								'edited': 0,
								'deleted': 0,
								'uploadedImages': ''
							};
						
						RDB.hmset('post:' + pid, postData);

						topics.increasePostCount(tid);
						topics.updateTimestamp(tid, timestamp);

						RDB.incr('totalpostcount');
							
						topics.getTopicField(tid, 'cid', function(cid) {
							RDB.handle(err);

							feed.updateTopic(tid, cid);

							RDB.zadd('categories:recent_posts:cid:' + cid, Date.now(), pid);

							// this is a bit of a naive implementation, defn something to look at post-MVP
							RDB.scard('cid:' + cid + ':active_users', function(amount) {
								if (amount > 10) {
									RDB.spop('cid:' + cid + ':active_users');
								}

								RDB.sadd('cid:' + cid + ':active_users', uid);
							});
						});					
						
						user.onNewPostMade(uid, tid, pid, timestamp);					

						var imgur = require('./imgur');
						// move clientID to config
						imgur.setClientID('09f3955fee9a0a6');
						
						var uploadedImages = [];					

						function uploadImage(image, callback) {
							imgur.upload(image.data, 'base64', function(err, data) {
								if(err) {
									callback(err);
								} else {
									if(data.success) {
										var img= {url:data.data.link, name:image.name};
										uploadedImages.push(img);
										callback(null);
									} else {
										callback(data);
									}
								}
							});			
						}

						plugins.fireHook('action:save_post_content', [pid, content]);
						
						if(!images) {
							postData.uploadedImages = JSON.stringify(uploadedImages);
							Posts.setPostField(pid, 'uploadedImages', postData.uploadedImages);
							callback(postData);
						} else {
							async.each(images, uploadImage, function(err) {
								if(!err) {
									postData.uploadedImages = JSON.stringify(uploadedImages);
									Posts.setPostField(pid, 'uploadedImages', postData.uploadedImages);
		
									callback(postData);
								} else {
									console.log(err);
									callback(null);
								}
							});
						}
					});
				});
			} else {
				callback(null);
			}
		});
	}
	
	Posts.getPostsByUid = function(uid, start, end, callback) {
		
		user.getPostIds(uid, start, end, function(pids) {
			
			if(pids && pids.length) {
			
				Posts.getPostsByPids(pids, function(posts) {
					callback(posts);
				});
			}
			else
				callback([]);
		});				
	}

	Posts.getTopicPostStats = function(socket) {
		RDB.mget(['totaltopiccount', 'totalpostcount'], function(err, data) {
			if(err === null) {
				var stats = {
					topics: data[0]?data[0]:0,
					posts: data[1]?data[1]:0				
				};
				
				socket.emit('post.stats', stats);
			}				
			else
				console.log(err);
		});
	}

}(exports));