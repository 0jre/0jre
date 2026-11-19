import React from 'react';
import {registerRootComponent} from 'expo';
import App from '../../App';
import {WalletProvider} from './WalletProvider';
function Root() {return <WalletProvider><App /></WalletProvider>;}
registerRootComponent(Root);
