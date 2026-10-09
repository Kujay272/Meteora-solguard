// Generate a throwaway Solana keypair for paper trading
import { Keypair } from '@solana/web3.js';
const kp = Keypair.generate();
console.log('Public key:', kp.publicKey.toBase58());
console.log('Private key (paste this into .env.Solana as SOLANA_PRIVATE_KEY):');
console.log('[' + Array.from(kp.secretKey).join(',') + ']');
