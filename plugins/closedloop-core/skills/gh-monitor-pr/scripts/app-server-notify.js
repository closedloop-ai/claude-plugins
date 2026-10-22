#!/usr/bin/env node

'use strict';

const modulePromise = import('./app-server-notify.mjs');

function parseArguments(argv) {
  return modulePromise.then((module) => module.parseArguments(argv));
}

function deliverPrompt(client, options, prompt, retryDelayMs) {
  return modulePromise.then((module) => module.deliverPrompt(client, options, prompt, retryDelayMs));
}

module.exports = { deliverPrompt, parseArguments };

if (require.main === module) {
  modulePromise.then((module) => module.run(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`App Server notification failed: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
