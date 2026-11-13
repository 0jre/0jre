const {getDefaultConfig} = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'isows' || moduleName.startsWith('zustand')) {
    const ctx = {...context, unstable_enablePackageExports: false};
    return ctx.resolveRequest(ctx, moduleName, platform);
  }
  if (moduleName === 'jose') {
    const ctx = {...context, unstable_conditionNames: ['browser']};
    return ctx.resolveRequest(ctx, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
