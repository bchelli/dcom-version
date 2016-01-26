# dcom-make-version

## 1 - Installation
```
npm install -g dcom-version
```

## 2 - Usage
Call ```dcom-version``` from your repository folder
```shell
$> cd my/git/repository
$> dcom-version
```
You will be prompted for:
- your Github username
- your Github password
- the Version number (semver) X.Y.Z
- the Label of the pull requests to merge (default: readyForMerge)

## 3 - Steps
- check repo if there is uncommited work (abort if this is the case)
- prompt user info
- get the PR from Github API that are opened with the specific ```label```
- fetch origin
- create the release branch if needed (for version: ```3.2.4``` the branch will be ```release_3.2```)
- pull the ```origin/release_3.2``` if it exists
- pull the ```origin/master```
- merge all the branches from the PRs, one at a time (if there is a conflict, you'll be asked to solve it)
- create the tag locally
- push the tag to origin
- push the brach to origin
- create the Github release
