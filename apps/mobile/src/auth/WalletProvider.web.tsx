import React, {useCallback} from 'react';
import {PrivyProvider, usePrivy, useLoginWithEmail, useWallets, useCreateWallet} from '@privy-io/react-auth';
import {useWallets as useSolanaWallets, useCreateWallet as useCreateSolanaWallet, useSignTransaction} from '@privy-io/react-auth/solana';
import {Buffer} from 'buffer';
import {getTransactionDecoder} from '@solana/kit';
import {DemoWalletProvider, WalletSessionContext, typedDataJson} from './WalletSession';
export {useWalletSession} from './WalletSession';

function ConnectedSession({children}: React.PropsWithChildren) {
  const {ready, authenticated, user, getAccessToken, logout} = usePrivy();
  const ethereum = useWallets();
  const solana = useSolanaWallets();
  const email = useLoginWithEmail();
  const {createWallet: createEthereumWallet} = useCreateWallet();
  const {createWallet: createSolanaWallet} = useCreateSolanaWallet();
  const {signTransaction} = useSignTransaction();
  const ethWallet = ethereum.wallets.find(wallet => wallet.walletClientType === 'privy');
  const solWallet = solana.wallets.find(wallet => user?.linkedAccounts.some(account =>
    account.type === 'wallet' && account.chainType === 'solana' && account.walletClientType === 'privy' && account.address === wallet.address));
  const sessionReady = ready && ethereum.ready && solana.ready;
  const freshAccessToken = useCallback(async () => {
    if (!ready || !authenticated) return null;
    return getAccessToken();
  }, [ready, authenticated, getAccessToken]);
  return <WalletSessionContext.Provider value={{
    configured: true, ready: sessionReady, userId: ready && authenticated ? user?.id ?? null : null,
    wallets: ready && authenticated ? [
      ...(solWallet ? [{address: solWallet.address, chain: 'solana' as const}] : []),
      ...(ethWallet ? [{address: ethWallet.address, chain: 'ethereum' as const}] : []),
    ] : [],
    getAccessToken: freshAccessToken,
    logout,
    sendEmailCode: async address => {await email.sendCode({email: address});},
    loginWithEmailCode: async (_address, code) => {await email.loginWithCode({code});},
    createWallet: async chain => {
      if (!sessionReady || !authenticated) throw new Error('Aguarde a sessão Privy.');
      if (chain === 'solana') {if (!solWallet) await createSolanaWallet();}
      else if (!ethWallet) await createEthereumWallet();
    },
    signSolanaTransaction: async base64 => {
      if (!sessionReady || !authenticated || !solWallet) throw new Error('Carteira Solana indisponível.');
      const transaction = new Uint8Array(Buffer.from(base64, 'base64'));
      // Reject malformed wire transactions before opening a signing prompt.
      getTransactionDecoder().decode(transaction);
      const {signedTransaction} = await signTransaction({transaction, wallet: solWallet});
      getTransactionDecoder().decode(signedTransaction);
      return Buffer.from(signedTransaction).toString('base64');
    },
    signTypedData: async typedData => {
      if (!sessionReady || !authenticated || !ethWallet) throw new Error('Carteira Ethereum indisponível.');
      const provider = await ethWallet.getEthereumProvider();
      const signature: unknown = await provider.request({method: 'eth_signTypedData_v4', params: [ethWallet.address, typedDataJson(typedData)]});
      if (typeof signature !== 'string') throw new Error('Assinatura Ethereum inválida.');
      return signature;
    },
  }}>{children}</WalletSessionContext.Provider>;
}
export function WalletProvider({children}: React.PropsWithChildren) {
  const appId = process.env.EXPO_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <DemoWalletProvider>{children}</DemoWalletProvider>;
  return <PrivyProvider appId={appId} clientId={process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID}
    config={{loginMethods: ['email'], appearance: {theme: 'dark', accentColor: '#d8ef80'}, embeddedWallets: {ethereum: {createOnLogin: 'off'}, solana: {createOnLogin: 'off'}}}}>
    <ConnectedSession>{children}</ConnectedSession>
  </PrivyProvider>;
}
