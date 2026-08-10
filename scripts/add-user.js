#!/usr/bin/env node
/**
 * add-user.js — hash a password with bcrypt and append the user to users.json.
 *
 * Plaintext is never written to disk. The password is read from a TTY prompt
 * with echo off; it is not accepted as an argv value, because argv lands in the
 * shell history and in `ps` output for every other user on the box.
 *
 * Usage:
 *   node scripts/add-user.js <username>
 *   node scripts/add-user.js <username> --reset   # replace an existing hash
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERS_PATH = path.join(__dirname, '..', 'users.json');
const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;

function readUsers() {
  if (!fs.existsSync(USERS_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('users.json must be a JSON array');
  return parsed;
}

/** Prompt without echoing. Resolves to the entered string. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error('stdin is not a TTY — run this interactively so the password is not logged')
      );
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // Echo suppression: readline writes every keystroke through
    // _writeToOutput. Emit the prompt itself and drop everything else, so the
    // typed password never reaches the terminal (or a scrollback buffer).
    rl._writeToOutput = function _writeToOutput(str) {
      if (str.includes(question)) rl.output.write(question);
    };

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith('--'));
  const reset = args.includes('--reset');

  if (!username) {
    console.error('usage: node scripts/add-user.js <username> [--reset]');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
    console.error('username must be 2-64 chars of [a-zA-Z0-9._-]');
    process.exit(1);
  }

  const users = readUsers();
  const existingIndex = users.findIndex((u) => u && u.username === username);
  if (existingIndex !== -1 && !reset) {
    console.error(`user "${username}" already exists — pass --reset to replace the hash`);
    process.exit(1);
  }

  const password = await promptHidden(`Password for "${username}": `);
  const confirm = await promptHidden('Confirm password: ');

  if (password !== confirm) {
    console.error('passwords do not match — nothing written');
    process.exit(1);
  }
  if (password.length < MIN_LENGTH) {
    console.error(`password must be at least ${MIN_LENGTH} characters — nothing written`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const record = { username, passwordHash };

  if (existingIndex !== -1) users[existingIndex] = record;
  else users.push(record);

  // Mode 0600: the hash file should not be world-readable on a shared box.
  fs.writeFileSync(USERS_PATH, `${JSON.stringify(users, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(USERS_PATH, 0o600);
  } catch {
    /* best effort */
  }

  console.log(
    `${existingIndex !== -1 ? 'Updated' : 'Added'} "${username}" in ${USERS_PATH} (bcrypt, ${BCRYPT_ROUNDS} rounds)`
  );
}

main().catch((err) => {
  console.error(`add-user failed: ${err.message}`);
  process.exit(1);
});
