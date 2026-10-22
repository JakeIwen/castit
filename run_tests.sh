#!/bin/zsh
# The whole suite: receiver, extension and Shortcut tests, plus CLI syntax. Stops at the
# first failure. Runs in a clean checkout; tests use youtube/local.example.json.
set -eu -o pipefail
root=${0:A:h}
cd "$root/youtube/receiver"
npm ci --no-audit --no-fund --silent
npm test
cd "$root/youtube/firefox"
node --test 'tests/**/*.test.mjs'
cd "$root/youtube/ios-shortcut"
node --test 'tests/*.test.mjs'
zsh -n "$root/youtube/ios-shortcut/build.zsh"
zsh -n "$root/youtube/vantv.zsh"
print 'PASS: castit suite'
