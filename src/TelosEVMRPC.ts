import {fastify, FastifyInstance, FastifyListenOptions} from "fastify";
import fastifyTraps from '@dnlup/fastify-traps'
import fastifyCors from '@fastify/cors'
import fetch from "node-fetch";
import Common, {default as ethCommon} from '@ethereumjs/common';
import {createLogger} from "./util/logger";
import evmRoute from './routes/evm'
import {RedisClientConnection, TelosEvmConfig} from "./types";
import WebsocketRPC from "./ws/WebsocketRPC";
import {JsonRpc} from 'eosjs';
import {
    APIClient,
    FetchProvider,
    Name,
    PrivateKey,
} from '@wharfkit/antelope'
import {Client} from "@elastic/elasticsearch";
import { createClient } from 'redis'

import {RedisClientOptions} from "@redis/client";

const logger = createLogger(`telos-evm-rpc`)
const {TelosEvmApi} = require('@telosnetwork/telosevm-js');

export default class TelosEVMRPC {
    debug = false;

    common: Common;
    baseChain = 'mainnet';
    hardfork = 'istanbul';
    fastify: FastifyInstance;
    config: TelosEvmConfig;
    websocketRPC: WebsocketRPC

    constructor(config: TelosEvmConfig) {
        this.config = config
        this.debug = config.debug
        if (config.chainId) {
            this.common = ethCommon.forCustomChain(
                this.baseChain,
                {chainId: config.chainId},
                this.hardfork
            );
        }

        this.fastify = fastify({
            trustProxy: true,
            logger: this.debug ? logger : false
        })
    }

    async start() {
        await this.fastify.register(fastifyCors)
        this.fastify.register(fastifyTraps, {
            timeout: 3000
        })

        this.fastify.decorate('eosjsRpc', new JsonRpc(this.config.nodeos_read))
        this.fastify.decorate('redis', await this.createRedisClient())
        this.fastify.decorate('elastic', this.createElasticsearchClient())
        await this.addRoutes();
        const opts: FastifyListenOptions = {
            host: this.config.apiHost,
            port: this.config.apiPort
        }

        this.fastify.listen(opts, err => {
            if (err) throw err
        })
    }

    async addRoutes(): Promise<void> {
        this.fastify.decorate('evm', new TelosEvmApi({
            // TODO: maybe this should be nodeos_write?  Need to check where we use fastify.evm and what it should be,
            //  possibly split up what we do so we have more granular control of which node type we use for which type of calls
            endpoint: this.config.nodeos_read,
            chainId: this.config.chainId,
            ethPrivateKeys: [],
            fetch: fetch,
            telosContract: this.config.contracts.main,
            telosPrivateKeys: [this.config.signer_key],
            signingPermission: this.config.signer_permission
        }));
        this.fastify.evm.setDebug(this.config.debug);

        this.fastify.decorate('rpcAccount', Name.from(this.config.signer_account))
        this.fastify.decorate('rpcPermission', Name.from(this.config.signer_permission))
        this.fastify.decorate('rpcKey', PrivateKey.from(this.config.signer_key))
        this.fastify.decorate('readApi', new APIClient({provider: new FetchProvider(this.config.nodeos_read)}))

        this.fastify.decorate('rpcPayloadHandlerContainer', {});

        await evmRoute(this.fastify, this.config);

        this.websocketRPC = new WebsocketRPC(this.config, this.fastify.rpcPayloadHandlerContainer);
    }

    createElasticsearchClient(): Client {
        return new Client({
            node: this.config.elasticNode,
            auth: {
                username: this.config.elasticUser,
                password: this.config.elasticPass
            }
        });
    }

    async createRedisClient(): Promise<RedisClientConnection> {
        const maxConnectRetry = 10
        const minConnectDelay = 100; // Milliseconds
        const maxConnectDelay = 60000; // Milliseconds

        const opts: RedisClientOptions = {
            url: `redis://${this.config.redisHost}:${this.config.redisPort}`,
            socket: {
                connectTimeout: 5000,
                reconnectStrategy: (retries) => {
                    if (retries > maxConnectRetry) {
                        console.log("Too many retries on redis. Connection Terminated");
                        return new Error("Redis reconnect strategy, too many retries.");
                    } else {
                        const wait = Math.min(minConnectDelay * Math.pow(2, retries), maxConnectDelay);
                        console.log("Redis reconnect strategy, waiting", wait, "milliseconds");
                        return wait;
                    }
                }
            }
        }
        if (this.config.redisUser && this.config.redisPass) {
            opts.username = this.config.redisUser
            opts.password = this.config.redisPass
        }
        const client = createClient(opts)
        client.on('error', err => console.error('Redis client error', err));
        client.on('connect', () => console.log('Redis client is connect'));
        client.on('reconnecting', () => console.log('Redis client is reconnecting'));
        client.on('ready', () => console.log('Redis client is ready'));
        await client.connect()

        return client
    }

}