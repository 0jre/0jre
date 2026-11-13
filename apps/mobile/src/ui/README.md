# ORBIT UI / TUFFUI

Official installation reference: https://tuffui.com/docs/installation

TUFFUI distributes source through a shadcn-compatible registry, not a native component package. This project uses its documented manual installation with React 19, TypeScript and Tailwind 4. Official MIT sources copied from:

- https://tuffui.com/r/action-button.json
- https://tuffui.com/r/status-pill.json
- https://tuffui.com/r/tooltip-hint.json

`./tuffui/` retains the upstream source and copyright notices. Only the project-specific import aliases are rewritten to relative imports. `utils.ts` is the documented clsx/tailwind-merge helper. These components do not require Motion; Tooltip uses CSS transitions. The source remains owned/customizable in this repository as intended by TUFFUI.

## Platform boundary

- `tuff.web.tsx` renders the actual registry Button and StatusPill, adapting the existing React Native layout props at the boundary.
- `tuff.tsx` implements native Pressable/Text equivalents. TUFFUI itself does **not** support React Native; the native adapter is ours, not an official TUFFUI native package.
- `auth/entry.web.ts` (and the explicit root web entry) imports compiled CSS only on web. Android/iOS use the existing native entry and never import registry DOM components or Tailwind CSS.
- `tuffui.css` contains the TUFFUI tokens with ORBIT's requested light white/black and dark black/blue themes. Green/red retain positive/negative meaning. There is no Tailwind preflight to interfere with React Native Web layout.

`palette.ts` is the corresponding native palette. Token parity and readable text contrast are covered by `theme.test.ts`. `ThemeProvider` follows the system until a user makes a choice, restores that choice from AsyncStorage, persists changes and synchronizes the DOM dark class. Both the header and settings expose a theme switch. Styles also cover the wallet and connected-trading panels; the upstream Privy SDK's own dialogs are not reskinned here.

## Build

`npm run web`, `npm start` and `npm run build:web` explicitly compile the Tailwind CSS before invoking Expo (not lifecycle hooks, because this workspace can disable those). Generated CSS is ignored; edit the source, not the generated file. For direct Expo CLI use run `npm run theme:css --workspace apps/mobile` first. After editing registry classes or CSS while Expo is running, regenerate CSS with the same command.

Validation:

```bash
npm run typecheck
npm test
npm run build:web
cd apps/mobile && npx expo export --platform android --output-dir dist/android
```

The Android export checks bundling/platform isolation, not an APK, device UI or real wallet signing. This UI change does not enable dispatch, move funds or alter backend risk controls.
