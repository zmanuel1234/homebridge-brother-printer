// The names Homebridge knows the plugin by. PLUGIN_NAME is package.json's "name"; PLATFORM_NAME is
// config.schema.json's "pluginAlias", the "platform" users write in config.json.
export const PLUGIN_NAME = 'homebridge-plugin-template';
export const PLATFORM_NAME = 'ExamplePlatform';

/** The plugin's settings, read from its block in config.json. */
export interface Settings {
  /** The switch's name in the Home app. */
  switchName: string;
  /** Turn the switch off again after this many seconds; 0 leaves it on. */
  resetSeconds: number;
}

export const DEFAULT_SWITCH_NAME = 'Example Switch';
export const MAX_RESET_SECONDS = 3600;

/**
 * Reads the settings, keeping to what the settings form allows: a name that is empty or not text
 * gets the default, and a reset time that isn't a number from 0 to 3600 is 0 (no reset).
 */
export function readSettings(config: Record<string, unknown>): Settings {
  const name = typeof config.switchName === 'string' ? config.switchName.trim() : '';
  const reset = typeof config.resetSeconds === 'number' ? config.resetSeconds : Number.NaN;
  return {
    switchName: name || DEFAULT_SWITCH_NAME,
    resetSeconds: Number.isFinite(reset) && reset >= 0 && reset <= MAX_RESET_SECONDS ? Math.round(reset) : 0,
  };
}
