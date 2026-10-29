// Creates the key pair for web push. The public key goes in site/config.js; the private key stays secret.
import fs from 'node:fs';
import webpush from 'web-push';
import { p } from './lib/util.js';

const keys = webpush.generateVAPIDKeys();
fs.writeFileSync(p('site/config.js'), `// Public web-push key. Safe to publish.\nwindow.SERVO_CONFIG = { vapidPublicKey: '${keys.publicKey}' };\n`);
console.log('Wrote the public key to site/config.js.\nAdd these to .env and to your GitHub secrets:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
