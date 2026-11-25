declare const __PACKAGE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : '0.0.0-test';

/** Added to every request's User-Agent. */
export const USER_AGENT = `ai-sdk/levanto/${VERSION}`;
