/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root  or https://opensource.org/licenses/BSD-3-Clause
 */
/**
 * An enum of all possible locations for a config value.
 * @typedef LOCATIONS
 * @property {string} GLOBAL Represents the global config.
 * @property {string} LOCAL Represents the local project config.
 * @property {string} ENVIRONMENT Represents environment variables.
 */
/**
 * Information about a config property.
 * @typedef ConfigInfo
 * @property {string} key The config key.
 * @property {string | boolean} value The config value.
 * @property {LOCATIONS} location The location of the config property.
 * @property {string} path The path of the config value.
 * @property {function} isLocal `() => boolean` Location is `LOCATIONS.LOCAL`.
 * @property {function} isGlobal `() => boolean` Location is `LOCATIONS.GLOBAL`.
 * @property {function} isEnvVar `() => boolean` Location is `LOCATIONS.ENVIRONMENT`.
 */

import * as _ from 'lodash';

import { SfdxConfig, ConfigPropertyMeta } from './sfdxConfig';
import { SfdxError } from '../sfdxError';

const propertyToEnvName = (property) => `SFDX_${_.snakeCase(property).toUpperCase()}`;

export const enum LOCATIONS {
    GLOBAL = 'Global',
    LOCAL = 'Local',
    ENVIRONMENT = 'Environment'
}

/**
 * Information about a config property.
 */
export interface ConfigInfo {
    key: string;
    location: LOCATIONS;
    value: string | boolean;
    path: string;
    /**
     * @returns true if the config property is in the local project
     */
    isLocal: () => boolean;

    /**
     * @returns true if the config property is in the global space
     */
    isGlobal: () => boolean;

    /**
     * @returns true if the config property is an environment variable.
     */
    isEnvVar: () => boolean;
}

/**
 * Aggregate global and local project config files, as well as environment variables for
 * `sfdx-config.json`. The resolution happens in the following bottom-up order:
 *
 * 1. Environment variables  (`SFDX_LOG_LEVEL`)
 * 1. Workspace settings  (`<workspace-root>/.sfdx/sfdx-config.json`)
 * 1. Global settings  (`$HOME/.sfdx/sfdx-config.json`)
 *
 * Use {@link SfdxConfigAggregator.create} to instantiate the aggregator.
 *
 * @example
 * const aggregator = await SfdxConfigAggregator.create();
 * console.log(aggregator.getPropertyValue('defaultusername'));
 *
 * @hideconstructor
 */
export class SfdxConfigAggregator {

    /**
     * Initialize the aggregator by reading and merging the global and local
     * sfdx config files, then resolving environment variables. This method
     * must be called before getting resolved config properties.
     *
     * @returns {Promise<SfdxConfigAggregator>} Returns the aggregated config object
     */
    public static async create(): Promise<SfdxConfigAggregator> {
        const configAggregator = new SfdxConfigAggregator();
        await configAggregator.loadProperties();
        return configAggregator;
    }

    private allowedProperties: any[];
    private localConfig: SfdxConfig;
    private globalConfig: SfdxConfig;
    private envVars: object;
    private config: object;

    /**
     * **Do not directly construct instances of this class -- use {@link SfdxConfigAggregator.resolve} instead.**
     *
     * @private
     * @constructor
     */
    protected constructor() {}

    /**
     * Retrieve the path to the config file.
     * @callback retrieverFunction
     * @param {boolean} isGlobal Is it the global or local project config file?
     * @returns {Promise<string>} The path of the config file.
     */

    /**
     * Get a resolved config property.
     *
     * @param {string} key The key of the property.
     * @returns {string | boolean}
     * @throws {SfdxError}
     *  **`{name: 'UnknownConfigKey'}`:** An attempt to get a property that's not supported.
     */
    public getPropertyValue(key: string): string | boolean   {
        if (this.getAllowedProperties().some((element) => key === element.key)) {
            return this.getConfig()[key];
        } else {
            throw new SfdxError(`Unknown config key: ${key}`, 'UnknownConfigKey');
        }
    }

    /**
     * Get a resolved config property.
     *
     * @param {string} key The key of the property.
     * @returns {ConfigInfo} The value of the property.
     */
    public getInfo(key: string): ConfigInfo {
        const location = this.getLocation(key);

        return {
            key,
            location,
            value: this.getPropertyValue(key),
            path: this.getPath(key),
            isLocal: () => location === LOCATIONS.LOCAL,
            isGlobal: () => location === LOCATIONS.GLOBAL,
            isEnvVar: () => location === LOCATIONS.ENVIRONMENT
        };
    }

    /**
     * Gets a resolved config property location.
     *
     * For example, `getLocation('logLevel')` will return:
     * 1. `LOCATIONS.GLOBAL` if resolved to an environment variable.
     * 1. `LOCATIONS.LOCAL` if resolved to local project config.
     * 1. `LOCATIONS.ENVIRONMENT` if resolved to the global config.
     *
     * @param {string} key The key of the property.
     * @returns {LOCATIONS}
     */
    public getLocation(key: string): LOCATIONS {
        if (!_.isNil(this.getEnvVars().get(key))) {
            return LOCATIONS.ENVIRONMENT;
        }

        if (this.getLocalConfig() && this.getLocalConfig().get(key)) {
            return LOCATIONS.LOCAL;
        }
        if (this.getGlobalConfig() && this.getGlobalConfig().get(key)) {
            return LOCATIONS.GLOBAL;
        }
        return null;
    }

    /**
     * Get a resolved file path or environment variable name of the property.
     *
     * For example, `getPath('logLevel')` will return:
     * 1. `$SFDX_LOG_LEVEL` if resolved to an environment variable.
     * 1. `./.sfdx/sfdx-config.json` if resolved to the local config.
     * 1. `~/.sfdx/sfdx-config.json` if resolved to the global config.
     *
     * **Note:** that the path returns may be the absolute path instead of
     * `./` and `~/`.
     *
     * @param {string} key The key of the property.
     * @returns {string}
     */
    public getPath(key: string): string {
        if (!_.isNil(this.envVars[key])) {
            return `\$${propertyToEnvName(key)}`;
        }
        if (!_.isNil(_.get(this.getLocalConfig(), `contents[${key}]`))) {
            return this.getLocalConfig().getPath();
        }
        if (!_.isNil(_.get(this.getGlobalConfig(), `contents[${key}]`))) {
            return this.getGlobalConfig().getPath();
        }
        return null;
    }

    /**
     * Get all resolved config property keys, values, locations, and paths.
     *
     * @example
     * > console.log(aggregator.getConfigInfo());
     * [
     *     { key: 'logLevel', val: 'INFO', location: 'Environment', path: '$SFDX_LOG_LEVEL'}
     *     { key: 'defaultusername', val: '<username>', location: 'Local', path: './.sfdx/sfdx-config.json'}
     * ]
     *
     * @returns {ConfigInfo[]}
     */
    public getConfigInfo(): ConfigInfo[] {
        const info = _.map(_.keys(this.getConfig()), (key: string) => this.getInfo(key));
        return _.sortBy(info, 'key') as any;
    }

    /**
     * Get the local project config instance.
     *
     * @returns {SfdxConfig}
     */
    public getLocalConfig(): SfdxConfig {
        return this.localConfig;
    }

    /**
     * Get the global config instance.
     *
     * @returns {SfdxConfig}
     */
    public getGlobalConfig(): SfdxConfig {
        return this.globalConfig;
    }

    /**
     * Get the resolved config object from the local, global and environment config instances.
     * @returns {object}
     */
    public getConfig(): object {
        return this.config;
    }

    /**
     * Get the config properties that are environment variables.
     * @returns {Map<string, string>}
     */
    public getEnvVars(): Map<string, string> {
        return new Map<string, string>(_.entries(this.envVars));
    }

    /**
     * Re-read all property configurations from disk.
     * @returns {Promise<void>}
     */
    public async reload(): Promise<SfdxConfigAggregator> {
        await this.loadProperties();
        return this;
    }

    /**
     * Loads all the properties and aggregates them according to location.
     * @returns {Promise<void>}
     * @private
     */
    private async loadProperties(): Promise<void> {
        // Don't throw an project error with the aggregator, since it should resolve to global if
        // there is no project.
        try {
            this.setLocalConfig(await SfdxConfig.create<SfdxConfig>(SfdxConfig.getDefaultOptions(false)));
        } catch (err) {
            if (err.name !== 'InvalidProjectWorkspace') {
                throw err;
            }
        }

        this.setGlobalConfig(await SfdxConfig.create<SfdxConfig>(SfdxConfig.getDefaultOptions(true)));

        this.setAllowedProperties(SfdxConfig.getAllowedProperties());

        this.setEnvVars(this.getAllowedProperties().reduce((obj, property) => {
            const val = process.env[propertyToEnvName(property.key)];
            if (!_.isNil(val)) {
                obj[property.key] = val;
            }
            return obj;
        }, {}));

        // Global config must be read first so it is on the left hand of the
        // object assign and is overwritten by the local config.

        await this.globalConfig.read();
        const configs = [(this.globalConfig.toObject() as object)];

        // We might not be in a project workspace
        if (this.localConfig) {
            await this.localConfig.read();
            configs.push((this.localConfig.toObject()) as object);
        }

        configs.push(this.envVars);

        this.setConfig(_.reduce(configs.filter(_.isObject), (result, configElement) =>
            _.merge(result, configElement), {}));

    }

    /**
     * Set the resolved config object.
     * @param config The config object to set.
     * @private
     */
    private setConfig(config: object) {
        this.config = config;
    }

    /**
     * Set the local config object.
     * @param {SfdxConfig} config The config object value to set.
     * @private
     */
    private setLocalConfig(config: SfdxConfig) {
        this.localConfig = config;
    }

    /**
     * Set the global config object.
     * @param {SfdxConfig} config The config object value to set.
     * @private
     */
    private setGlobalConfig(config: SfdxConfig) {
        this.globalConfig = config;
    }

    /**
     * Get the allowed properties.
     * @returns {ConfigPropertyMeta[]}
     * @private
     */
    private getAllowedProperties(): ConfigPropertyMeta[] {
        return this.allowedProperties;
    }

    /**
     * Set the allowed properties.
     * @param {ConfigPropertyMeta[]} properties The properties to set.
     * @private
     */
    private setAllowedProperties(properties: ConfigPropertyMeta[]) {
        this.allowedProperties = properties;
    }

    /**
     * Sets the env variables.
     * @param {object} envVars The env variables to set.
     * @private
     */
    private setEnvVars(envVars: object) {
        this.envVars = envVars;
    }
}
