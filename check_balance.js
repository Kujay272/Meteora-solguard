// Devnet SOL balance check.
//
// The keypair is read from the environment. Never hardcode a secret key in a
// file that can be committed — a private key in a public repo is compromised
// the moment it lands, and deleting the commit does not undo it.
//
// SOLANA_PRIVATE_KEY must be a JSON byte array, the same format the engine
// reads from .env.Solana (which is gitignored).

require('dotenv').config({ path: '.env.Solana' });

const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const raw = process.env.SOLANA_PRIVATE_KEY;
if (!raw) {
  console.error('SOLANA_PRIVATE_KEY not set. Add it to .env.Solana (gitignored).');
  process.exit(1);
}

let keypair;
try {
  keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
} catch (err) {
  console.error('SOLANA_PRIVATE_KEY must be a JSON byte array, e.g. [1,2,3,...].');
  process.exit(1);
}

const rpc = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const connection = new Connection(rpc, { commitment: 'confirmed' });

connection.getBalance(keypair.publicKey)
  .then(balance => {
    console.log('SOL:', balance / LAMPORTS_PER_SOL);
    console.log('Wallet address:', keypair.publicKey.toBase58());
  })
  .catch(err => console.error('Error:', err.message));
