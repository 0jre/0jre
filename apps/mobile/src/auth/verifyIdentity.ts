export interface IdentityCheckOptions {
  userId: string | null;
  getAccessToken(): Promise<string | null>;
  apiUrl: string;
  requireApiUrl: boolean;
  fetcher?: typeof fetch;
}
/** Fresh SDK token per request. Tokens remain local to this call, never persisted. */
export async function verifyBackendIdentity({userId, getAccessToken, apiUrl, requireApiUrl, fetcher = fetch}: IdentityCheckOptions): Promise<string> {
  if (requireApiUrl && !apiUrl) throw new Error('Configure EXPO_PUBLIC_API_URL para o aplicativo nativo.');
  if (!userId) throw new Error('Entre com Privy antes de verificar a sessão.');
  const token = await getAccessToken();
  if (!token) throw new Error('Sessão Privy indisponível. Entre novamente.');
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/v1/me`, {
    headers: {Authorization: `Bearer ${token}`}, cache: 'no-store',
  });
  if (!response.ok) throw new Error('O backend não aceitou a sessão Privy.');
  const identity: unknown = await response.json();
  if (!identity || typeof identity !== 'object' || !('userId' in identity) || identity.userId !== userId) {
    throw new Error('A identidade retornada pelo backend não corresponde à sessão.');
  }
  return userId;
}
