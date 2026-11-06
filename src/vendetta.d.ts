declare module "@vendetta/*" { const x: any; export = x; }
declare module "@vendetta/metro" { export const findByProps: any, findByStoreName: any, findByName: any, find: any; }
declare module "@vendetta/metro/common" { export const React: any, ReactNative: any, FluxDispatcher: any, url: any; }
declare module "@vendetta/patcher" { export const before: any, after: any, instead: any; }
declare module "@vendetta/plugin" { export const storage: any; }
declare module "@vendetta/storage" { export const useProxy: any; }
declare module "@vendetta/ui/assets" { export const getAssetIDByName: (name: string) => number; }
declare module "@vendetta/ui/components" { export const Forms: any; }
declare module "@vendetta/ui/toasts" { export const showToast: (text: string, icon?: number) => void; }
declare module "@vendetta/utils" { export const findInReactTree: any; }
declare const React: any;
declare namespace JSX { interface IntrinsicElements { [k: string]: any; } }
