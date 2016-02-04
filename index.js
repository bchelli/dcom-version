#!/usr/bin/env node

/*
 * Dependencies
 */
var commander = require('commander');
var prompt = require('prompt');
var execFile = require('child_process').execFile;
var GitHubApi = require('github');
var Promise = require('promise');
var path = require('path');
var pack = require('./package.json');



/*
 * Config
 */
var config = {};




var program = commander
	.version(pack.version)
	.option('-u, --username <username>', 'Github username')
	.option('-p, --password <password>', 'Github password')
	.option('-l, --label <label>', 'Github Pull-request label to filter')
	.option('-b, --build <version>', 'Version of the release')
	.option('-r, --repository <repository>', 'Path to the repository', absolutePath, process.cwd())
	.option('-s, --skip-merge-conflict', 'Skip merge conflicts and notify the user that the branch was skipped')
	.option('-c, --clear', 'Clear the release branch and start from scratch')
	.option('-s, --silent', 'Don\'t output the info logs')
	.parse(process.argv);


Promise.resolve(config)

	/*
	 * Check if the repo is clean
	 */
	.then(checkRepo)

	/*
	 * Save current branch
	 */
	.then(saveCurrentBranch)

	/*
	 * Prompt Github username / password and the version
	 */
	.then(function () {
		return promptUserFor({
			username: {
				description: 'Github username:',
				required: true
			},
			password: {
				description: 'Github password:',
				required: true,
				hidden: true
			},
			build: {
				pattern: /^[0-9]*\.[0-9]*\.[0-9]*$/,
				description: 'Version number:',
				required: true
			},
			label: {
				description: 'Label (default: readyForMerge):',
			},
		}, program)
		.then(function (inputs) {
			config.label = inputs.label;
			config.version = inputs.build;
			config.githubCredentials = {
				username: inputs.username,
				password: inputs.password,
			};
		})
		;
	})

	/*
	 * Get repository info
	 */
	.then(getRepoNameAndOwner)

	/*
	 * Get pull requests to merge
	 */
	.then(getPullRequestToMerge)

	/*
	 * Fetch
	 */
	.then(fetch)

	/*
	 * Create release branch
	 */
	.then(gotToReleaseBranch)

	/*
	 * Merge branches
	 */
	.then(mergeBranches)

	/*
	 * Create tag
	 */
	.then(createTag)

	/*
	 * Go back to original branch
	 */
	.then(goBackToPreviousBranch)

	/*
	 * Push the branch
	 */
	.then(pushBranch)

	/*
	 * Push the tag
	 */
	.then(pushTag)

	/*
	 * Create the Github release
	 */
	.then(delay(2000))
	.then(createRelease)

	/*
	 * Display the recap
	 */
	.then(displayRecap)

	/*
	 * Clean up
	 */
	.catch(function (error) {
		config.errorCaught = true;
		console.error(error);
		return cleanUpModifications()
			.then(goBackToPreviousBranch)
			.then(cleanUpBranch)
			.then(cleanUpTag)
			;
	})

	/*
	 * Handle exit status
	 */
	.then(function () {
		if (config.errorCaught || config.failedBranches.length) {
			process.exit(1);
		}
		process.exit();
	})

	;







/*
 * Git Helpers
 */
function saveCurrentBranch () {
	return gitExec({
		noLog: true,
		args: ['rev-parse', '--abbrev-ref', 'HEAD'],
	})
	.then(function (branch) {
		config.currentBranch = branch.trim();
	})
	;
}

function getRepoNameAndOwner () {
	return gitExec({
		noLog: true,
		args: ['remote', '-v'],
	})
	.then(function (content) {
		return content.split('\n')[0];
	})
	.then(function (remote) {
		var matches = remote.match(/([^\/\:]*)\/([^\/\:]*)\.git/);

		config.repository = {
			owner: matches[1],
			name: matches[2],
		};
	})
	;
}

function checkRepo () {
	return gitExec({
		noLog: true,
		args: ['status', '--porcelain', '--untracked-files=no'],
	})
	.then(function (content) {
		return content.split('\n').filter(function (line) { return line !== ''; });
	})
	.then(function (modifiedFiles) {
		if (modifiedFiles.length) {
			console.log('CAN\'T START THE PROCESS:');
			console.log('You have modified files, please commit or stash your work in order to proceed');
			console.log('');
			modifiedFiles.map(function (file) { console.log('\t', file); });
			process.exit();
		}
		return true;
	})
	;
}

function fetch () {
	return gitExec({
		args: ['fetch', '--all'],
	});
}

function gotToReleaseBranch () {
	config.releaseBranch = 'release_'+config.version.split('.').slice(0, 2).join('.');

	var branchCheckout = gitExec({
		args: ['checkout', '-b', config.releaseBranch, 'origin/master'],
	})
	.catch(function () {
		return gitExec({
			args: ['checkout', config.releaseBranch],
		});
	});

	if (program.clear) {
		return branchCheckout
		.then(function () {
			return gitExec({
				args: ['reset', '--hard', 'origin/master'],
			});
		});
	}

	return branchCheckout;
}

function mergeBranches (options) {

	var prepBranches = ['master'];

	if (!program.clear) {
		prepBranches.unshift(config.releaseBranch);
	}

	config.failedBranches = config.failedBranches || [];

	var position = options.position || 0;
	var branches = options.branches || [].concat(
		prepBranches,
		config.pullRequests.map(function (b) { return b.head.ref; })
	);

	var branch = branches[position];

	// if no branch left... we are done.
	if (!branch) {
		return Promise.resolve(branches);
	}

	function next () {
		return mergeBranches({
			branches: branches,
			position: position+1
		});
	}

	return branchExists(branch)
	.then(function (exists) {
		if (!exists) {
			return next();
		}
		return gitExec({
			args: ['merge', '--no-commit', '--no-ff', 'origin/'+branch],
		})
		.catch(function () {
			return gitExec({
				args: ['diff'],
			})
			.then(function (content) {
				if (program.skipMergeConflict) {
					return gitExec({
						args: ['merge', '--abort'],
					})
					.then(function () {
						config.failedBranches.push(branch);
					});
				}
				console.log(content);
				return promptUserFor({
					valid: {
						pattern: /^(yes|no)$/,
						description: 'Please resolve the merge conflict. When you are done please type\n\t- "yes" to proceed\n\t- "no" to abort the creation of the release\nyes/no?',
						required: true
					},
				})
				.then(function (response) {
					if (response.valid === 'no') {
						throw new Error('Stop process => rollback');
					}
				});
			})
			;
		})
		.then(function () {
			return gitExec({
				canFail: true,
				args: ['commit', '-am', 'Merge branch "'+branch+'" for release '+config.version+' by '+config.githubCredentials.username],
			});
		})
		.then(next)
		;
	})
	;
}

function createTag () {
	var now = new Date();
	return gitExec({
		args: ['tag', '-a', config.version, '-m', 'Release by '+config.githubCredentials.username+' on '+now.toISOString().substr(0, 10)],
	});
}

function goBackToPreviousBranch () {
	return gitExec({
		noLog: true,
		args: ['checkout', config.currentBranch],
	})
	;
}

function cleanUpBranch () {
	return gitExec({
		noLog: true,
		args: ['branch', '-D', config.releaseBranch],
	})
	;
}

function cleanUpTag () {
	return gitExec({
		noLog: true,
		args: ['tag', '-d', config.version],
	})
	;
}

function cleanUpModifications () {
	return gitExec({
		noLog: true,
		args: ['reset', '--hard', 'HEAD'],
	})
	;
}

function pushTag () {
	return gitExec({
		args: ['push', 'origin', config.version],
	})
	;
}

function pushBranch () {
	return gitExec({
		args: ['push', 'origin', config.releaseBranch],
	})
	;
}








/*
 * Github Helpers
 */
function connectGithub () {
	if (config.github) {
		return;
	}

	config.github = new GitHubApi({
		version: '3.0.0',
		protocol: 'https',
		host: 'api.github.com',
		timeout: 5000,
		headers: {
			'user-agent': 'com.delivery.make-version'
		}
	});

	config.github.authenticate({
		type: 'basic',
		username: config.githubCredentials.username,
		password: config.githubCredentials.password
	});
}

function getPullRequestToMerge () {

	return new Promise(function (resolve, reject) {

		var isRejected = false;
		function r (value) {
			if (!isRejected) {
				isRejected = true;
				reject(value);
			}
		}

		/*
		 * Connect to Github
		 */
		connectGithub();



		/*
		 * Get the issues
		 */
		config.github.issues.repoIssues({
			user: config.repository.owner,
			repo: config.repository.name,
			state: 'open',
			labels: config.label || 'readyForMerge',
		}, function(err, res) {
			if (err) {
				return r(err);
			}
			var pendingIssues = res.length;
			var pullRequests = [];
			res.forEach(function (issue) {
				config.github.pullRequests.get({
					user: config.repository.owner,
					repo: config.repository.name,
					number: issue.number,
				}, function(err, res) {
					if (err) {
						return r(err);
					}
					pullRequests.push(res);
					pendingIssues--;
					if (pendingIssues === 0) {
						config.pullRequests = pullRequests;
						resolve(pullRequests);
					}
				});
			});
		});

	});

}

function branchExists (branch) {
	return new Promise(function (resolve, reject) {

		/*
		 * Connect to Github
		 */
		connectGithub();



		/*
		 * Get the branch
		 */
		config.github.repos.getBranch({
			user:   config.repository.owner,
			repo:   config.repository.name,
			branch: branch,
		}, function (err, res) {
			if (err) {
				return resolve(false);
			}
			return resolve(true);
		});

	});
}

function createRelease () {
	return new Promise(function (resolve, reject) {

		/*
		 * Connect to Github
		 */
		connectGithub();



		/*
		 * Get the branch
		 */
		var now = new Date();

		config.bodyRelease = 'Content:\n' + config.pullRequests.map(function (pr) {
			return '- '+pr.head.ref+': '+pr.title;
		}).join('\n');

		if (config.failedBranches.length) {
			config.bodyRelease += '\n\n\nMerge Conflicts:\n' + config.failedBranches.map(function (branch) {
				return '- '+branch;
			}).join('\n');
		}

		config.github.releases.createRelease({
			owner:            config.repository.owner,
			repo:             config.repository.name,
			tag_name:         config.version,
			target_commitish: config.releaseBranch,
			name:             'Release '+now.toISOString().substr(0, 10),
			body:             config.bodyRelease,
			prerelease:       true
		}, function (err, res) {
			if (err) {
				console.error('Unable to create the Github Release', err);
			}
			resolve();
		});

	});
}







/*
 * Helpers
 */
function gitExec (options) {
	return new Promise(function (resolve, reject) {
		options.cmd  = options.cmd  || 'git';
		options.args = options.args || [];
		execFile(
			options.cmd,
			options.args,
			{
				cwd: options.path || program.repository,
				encoding: 'utf8'
			},
			function (error, stdout, stderr) {
				if (!options.canFail) {
					var cmd = [].concat([options.cmd], options.args).join(' ');
					if (error) {
						if (!options.noLog && !program.silent) {
							console.log('ERROR', cmd);
						}
						return reject(error);
					}
					if (!options.noLog && !program.silent) {
						console.log('SUCCESS', cmd);
					}
				}
				resolve(stdout && stdout.toString('utf8') || '');
			}
		);
	});
}

function promptUserFor (properties, values) {

	var keys = Object.keys(properties);
	var keysToPrompt = keys.filter(function (k) { return typeof values[k] === 'undefined'; });

	if (!keysToPrompt.length) {
		return Promise.resolve(keys.reduce(function (props, key) {
			props[key] = values[key];
			return props;
		}, {}));
	}

	var props = keysToPrompt.reduce(function (props, key) {
		props[key] = properties[key];
		return props;
	}, {});

	return new Promise(function (resolve, reject) {

		prompt.message = '';
		prompt.delimiter = '';
		prompt.start();
		prompt.get({ properties: props }, function (err, result) {
			if (err) {
				return reject(err);
			}
			resolve(keys.reduce(function (props, key) {
				props[key] = typeof result[key] === 'undefined' ? values[key] : result[key];
				return props;
			}, {}));
		});

	});

}

function delay (time) {
	return function () {
		return new Promise (function (resolve, reject) {
			setTimeout(resolve, time);
		});
	}
}

function displayRecap () {
	console.log('');
	console.log('');
	console.log('Version '+config.version);
	console.log('');
	console.log(config.bodyRelease)
	console.log('');
	console.log('');
	return true;
}

function absolutePath (p) {
	return path.resolve(p);
}
