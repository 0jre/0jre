import React, {useCallback} from 'react';
import {PrivyProvider, usePrivy, useLoginWithEmail, useEmbeddedEthereumWallet, useEmbeddedSolanaWallet} from '@privy-io/expo';
import {Buffer} from 'buffer';
import {VersionedTransaction} from '@solana/web3.js';
import {DemoWalletProvider, WalletSessionContext, typedDataJson} from './WalletSession';
export {useWalletSession} from './WalletSession';

function ConnectedSession({children}: React.PropsWithChildren) {
  const {isReady, user, getAccessToken, logout} = usePrivy();
  const ethereum = useEmbeddedEthereumWallet();
  const solana = useEmbeddedSolanaWallet();
  const email = useLoginWithEmail();
  const ethWallet = ethereum.wallets[0];
  const solWallet = solana.wallets?.[0];
  const freshAccessToken = useCallback(async () => {
    if (!isReady || !user) return null;
    return getAccessToken();
  }, [isReady, user, getAccessToken]);
  return <WalletSessionContext.Provider value={{
    configured: true, ready: isReady, userId: isReady ? user?.id ?? null : null,
    wallets: isReady && user ? [
      ...(solWallet ? [{address: solWallet.address, chain: 'solana' as const}] : []),
      ...(ethWallet ? [{address: ethWallet.address, chain: 'ethereum' as const}] : []),
    ] : [],
    getAccessToken: freshAccessToken,
    logout,
    sendEmailCode: async address => {await email.sendCode({email: address});},
    loginWithEmailCode: async (address, code) => {await email.loginWithCode({email: address, code});},
    createWallet: async chain => {
      if (!isReady || !user) throw new Error('Aguarde a sessão Privy.');
      if (chain === 'solana') {
        if (!solWallet) {
          if (!solana.create) throw new Error('Carteira Solana inicializando. Tente novamente.');
          await solana.create();
        }
      }
      else if (!ethWallet) await ethereum.create();
    },
    signSolanaTransaction: async base64 => {
      if (!isReady || !user || !solWallet) throw new Error('Carteira Solana indisponível.');
      // VersionedTransaction.deserialize also understands legacy wire messages.
      const transaction = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(base64, 'base64')));
      const provider = await solWallet.getProvider();
      const {signedTransaction} = await provider.request({method: 'signTransaction', params: {transaction}});
      return Buffer.from(signedTransaction.serialize()).toString('base64');
    },
    signTypedData: async typedData => {
      if (!isReady || !user || !ethWallet) throw new Error('Carteira Ethereum indisponível.');
      const provider = await ethWallet.getProvider();
      const signature: unknown = await provider.request({method: 'eth_signTypedData_v4', params: [ethWallet.address, typedDataJson(typedData)]});
      if (typeof signature !== 'string') throw new Error('Assinatura Ethereum inválida.');
      return signature;
    },
  }}>{children}</WalletSessionContext.Provider>;
}
export function WalletProvider({children}: React.PropsWithChildren) {
  const appId = process.env.EXPO_PUBLIC_PRIVY_APP_ID;
  const clientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID;
  if (!appId || !clientId) return <DemoWalletProvider>{children}</DemoWalletProvider>;
  return <PrivyProvider appId={appId} clientId={clientId}><ConnectedSession>{children}</ConnectedSession></PrivyProvider>;
}
