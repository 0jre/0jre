import React, {createContext, useContext} from 'react';

export type WalletChain = 'solana' | 'ethereum';
export interface WalletSession {
  configured: boolean;
  ready: boolean;
  userId: string | null;
  wallets: {address: string; chain: WalletChain}[];
  getAccessToken(): Promise<string | null>;
  signSolanaTransaction(base64: string): Promise<string>;
  signTypedData(typedData: unknown): Promise<string>;
  logout(): Promise<void>;
  sendEmailCode(email: string): Promise<void>;
  loginWithEmailCode(email: string, code: string): Promise<void>;
  createWallet(chain: WalletChain): Promise<void>;
}
const unavailable = async (): Promise<never> => {throw new Error('Privy não configurado. O simulador continua disponível.');};
export const demoSession: WalletSession = {
  configured: false, ready: true, userId: null, wallets: [],
  getAccessToken: async () => null, signSolanaTransaction: unavailable,
  signTypedData: unavailable, logout: async () => {}, sendEmailCode: unavailable,
  loginWithEmailCode: unavailable, createWallet: unavailable,
};
export const WalletSessionContext = createContext<WalletSession>(demoSession);
export const useWalletSession = () => useContext(WalletSessionContext);
export function DemoWalletProvider({children}: React.PropsWithChildren) {
  return <WalletSessionContext.Provider value={demoSession}>{children}</WalletSessionContext.Provider>;
}

// Only serialize the EIP-712 payload; the wallet's own provider controls signing.
export function typedDataJson(value: unknown): string {
  if (!value || typeof value !== 'object' || !('domain' in value) || !('types' in value) || !('message' in value) || !('primaryType' in value)) {
    throw new Error('Payload EIP-712 inválido.');
  }
  return JSON.stringify(value);
}
