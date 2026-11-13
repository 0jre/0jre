import React, {useEffect, useRef, useState} from 'react';
import {Platform, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {useWalletSession} from './WalletProvider';
import {verifyBackendIdentity} from './verifyIdentity';

function Action({label, onPress, disabled}: {label: string; onPress(): void; disabled?: boolean}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.button, disabled && {opacity: 0.45}]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
export function WalletPanel() {
  const session = useWalletSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authCheck, setAuthCheck] = useState<{userId: string; message: string} | null>(null);
  const userIdRef = useRef(session.userId);
  userIdRef.current = session.userId;
  useEffect(() => {setAuthCheck(null); setCode(''); setCodeSent(false); setError('');}, [session.userId]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try {await action();} catch {setError('Não foi possível concluir. Verifique a configuração, o código e a conexão e tente novamente.');}
    finally {setBusy(false);}
  };
  const verifyBackend = () => run(async () => {
    setAuthCheck(null);
    const expectedUser = session.userId;
    const verifiedUser = await verifyBackendIdentity({
      userId: expectedUser, getAccessToken: session.getAccessToken,
      apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '', requireApiUrl: Platform.OS !== 'web',
    });
    if (userIdRef.current === verifiedUser) setAuthCheck({userId: verifiedUser, message: 'Autenticação verificada pelo backend (/v1/me).'});
  });
  return <View style={styles.panel}>
    <Text style={styles.title}>Sua conexão Privy</Text>
    <Text style={styles.description}>Conta real separada da carteira paper. Entrar ou criar carteiras não assina nem envia operações.</Text>
    {!session.configured ? <Text style={styles.notice}>Privy não configurado. O modo demonstração permanece disponível. Configure EXPO_PUBLIC_PRIVY_APP_ID{Platform.OS !== 'web' ? ' e EXPO_PUBLIC_PRIVY_CLIENT_ID' : ''} para habilitar o login.</Text> : !session.ready ? <Text style={styles.description}>Inicializando sessão segura…</Text> : !session.userId ? <>
      <Text style={styles.label}>Email</Text>
      <TextInput accessibilityLabel="Email para login Privy" value={email} onChangeText={value => {setEmail(value); setCode(''); setCodeSent(false);}} editable={!busy && !codeSent} inputMode="email" autoCapitalize="none" autoCorrect={false} placeholder="voce@exemplo.com" placeholderTextColor="#939a9f" style={styles.input}/>
      {!codeSent ? <Action label="Enviar código por email" disabled={busy || !email.trim()} onPress={() => run(async () => {await session.sendEmailCode(email.trim()); setCodeSent(true);})}/> : <>
        <Text style={styles.label}>Código recebido por email</Text>
        <TextInput accessibilityLabel="Código de verificação Privy" value={code} onChangeText={setCode} editable={!busy} inputMode="numeric" autoComplete="one-time-code" style={styles.input}/>
        <Action label="Entrar com código" disabled={busy || !code.trim()} onPress={() => run(async () => {await session.loginWithEmailCode(email.trim(), code.trim()); setCode('');})}/>
        <Action label="Reenviar código" disabled={busy} onPress={() => run(async () => {await session.sendEmailCode(email.trim());})}/>
        <Action label="Usar outro email" disabled={busy} onPress={() => {setCodeSent(false); setCode('');}}/>
      </>}
    </> : <>
      <Text selectable style={styles.label}>Conectado: {session.userId}</Text>
      {session.wallets.map(wallet => <View key={`${wallet.chain}:${wallet.address}`} style={styles.wallet}><Text style={styles.label}>{wallet.chain === 'solana' ? 'Solana' : 'Ethereum'}</Text><Text selectable style={styles.address}>{wallet.address}</Text></View>)}
      {!session.wallets.some(wallet => wallet.chain === 'solana') && <Action label="Criar carteira Solana" disabled={busy} onPress={() => run(() => session.createWallet('solana'))}/>}
      {!session.wallets.some(wallet => wallet.chain === 'ethereum') && <Action label="Criar carteira Ethereum" disabled={busy} onPress={() => run(() => session.createWallet('ethereum'))}/>}
      <Action label="Verificar autenticação no backend" disabled={busy} onPress={verifyBackend}/>
      {authCheck?.userId === session.userId && <Text accessibilityLiveRegion="polite" style={styles.notice}>{authCheck.message}</Text>}
      {Platform.OS !== 'web' && !process.env.EXPO_PUBLIC_API_URL && <Text style={styles.notice}>Defina EXPO_PUBLIC_API_URL com o endereço HTTPS do backend para verificar a sessão no aplicativo nativo.</Text>}
      <Action label="Sair da conta Privy" disabled={busy} onPress={() => run(async () => {setAuthCheck(null); await session.logout();})}/>
    </>}
    {Platform.OS !== 'web' && <Text style={styles.label}>Requer development build com módulos nativos Privy. Não funciona no Expo Go.</Text>}
    {busy && <Text accessibilityLiveRegion="polite" style={styles.description}>Aguardando resposta…</Text>}
    {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  panel: {backgroundColor: '#15191f', borderColor: '#353c45', borderWidth: 1, borderRadius: 18, padding: 17, gap: 13, marginVertical: 14},
  title: {color: '#f2f5ef', fontSize: 17, fontWeight: '600'},
  description: {color: '#bac3c8', fontSize: 12, lineHeight: 20},
  label: {color: '#a6b0b8', fontSize: 11, lineHeight: 18},
  notice: {color: '#d8ef80', fontSize: 12, lineHeight: 20},
  input: {color: '#f2f5ef', backgroundColor: '#101318', borderColor: '#414a55', borderWidth: 1, padding: 12, borderRadius: 10, fontSize: 14},
  button: {backgroundColor: '#d8ef80', borderRadius: 12, padding: 12, alignItems: 'center'},
  buttonText: {color: '#15191f', fontSize: 13, fontWeight: '600'},
  wallet: {gap: 4, paddingVertical: 8},
  address: {color: '#edf1e8', fontSize: 11, lineHeight: 18},
  error: {color: '#ff9ba3', fontSize: 12, lineHeight: 20},
});
