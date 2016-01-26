#!/usr/bin/env node

/*
 * Dependencies
 */
var prompt = require('prompt');
var execFile = require('child_process').execFile;
var GitHubApi = require('github');



/*
 * Config
 */
var config = {
	path: process.cwd()
};



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
			version: {
				pattern: /^[0-9]*\.[0-9]*\.[0-9]*$/,
				description: 'Version number:',
				required: true
			},
			label: {
				description: 'Label (default: readyForMerge):',
			},
		})
		.then(function (inputs) {
			config.label = inputs.label;
			config.version = inputs.version;
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
		console.error(error);
		return cleanUpModifications()
			.then(goBackToPreviousBranch)
			.then(cleanUpBranch)
			.then(cleanUpTag)
			;
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
	return gitExec({
		args: ['checkout', '-b', config.releaseBranch, 'origin/master'],
	})
	.catch(function () {
		return gitExec({
			args: ['checkout', config.releaseBranch],
		});
	});
}

function mergeBranches (options) {
	position = options.position || 0;
	branches = options.branches || [].concat(
		[
			config.releaseBranch,
			'master'
		],
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
				console.log(content);
				return promptUserFor({
					valid: {
						pattern: /^(yes|no)$/,
						description: 'Please resolve the merge conflict. When you are done please type\n\t- "yes" to proceed\n\t- "no" to cancel the creation of the release\nyes/no?',
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
				cwd: options.path || config.path,
				encoding: 'utf8'
			},
			function (error, stdout, stderr) {
				if (!options.canFail) {
					var cmd = [].concat([options.cmd], options.args).join(' ');
					if (error) {
						if (!options.noLog) {
							console.log('ERROR', cmd);
						}
						return reject(error);
					}
					if (!options.noLog) {
						console.log('SUCCESS', cmd);
					}
				}
				resolve(stdout && stdout.toString('utf8') || '');
			}
		);
	});
}

function promptUserFor (properties) {

	return new Promise(function (resolve, reject) {

		prompt.message = '';
		prompt.delimiter = '';
		prompt.start();
		prompt.get({ properties: properties }, function (err, result) {
			if (err) {
				return reject(err);
			}
			resolve(result);
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
