#!/bin/sh

setup_git() {
  echo ${GIT_TOKEN}
  git clone https://${GIT_TOKEN}@github.com/privatesky/privatesky.git ../results > /dev/null 2>&1
  cd ../results
  git config user.email "psk.build.track@gmail.com"
  git config user.name "PSK Build Tracker"
  git checkout test_reports
}

commit_test_report() {
  git pull --all
  cp ../privatesky/testReport.html tests/psk-smoke-testing/testReport.html
  git add -f tests/psk-smoke-testing/testReport.html
  git commit --message "Travis build: $TRAVIS_BUILD_NUMBER"
}

push_to_github() {
  git push origin test_reports
  cd .. && rm -rf results
}

setup_git
commit_test_report
push_to_github
