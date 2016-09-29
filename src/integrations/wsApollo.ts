import { Observable } from 'rxjs';
import * as graphql from 'graphql';
import * as WebSocket from 'ws';
import ApolloOptions from './apolloOptions';
import { runQueryReactive } from '../core/runQuery';
import 'rxjs-diff-operator';

interface WsMessageParams {
    requestParams: any;
    apolloOptions?: ApolloOptions;
    flags: {
        binary: boolean;
    };
}

export interface WsApolloOptionsFunction {
  (ws: WebSocket): ApolloOptions | Promise<ApolloOptions>;
}

export interface WsHandler {
    (ws: WebSocket): void;
}

function isOptionsFunction(arg: ApolloOptions | WsApolloOptionsFunction): arg is WsApolloOptionsFunction {
  return typeof arg === 'function';
}

function ObservableFromWs(ws): Observable<WsMessageParams> {
    return new Observable<any>((observer) => {
        let nextListener = (data: any, flags: {binary: boolean}) => {
            observer.next({ data: data, flags: flags });
        };
        let errorListener = (e: Error) => {
            observer.error(e);
        };
        let completeListener = () => {
            observer.complete();
        };
        ws.on('message', nextListener);
        ws.on('error', errorListener);
        ws.on('close', completeListener);

        return () => {
            ws.removeListener('close', completeListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('message', nextListener);

            ws.close();
        };
    }).map(({data, flags}) => {
        try {
            return { requestParams: JSON.parse(data), flags: flags };
        } catch (e) {
            throw new Error('Message must be JSON-parseable.');
        }
    }).share();
}

function ObservableFromOptions(ws, options: ApolloOptions | WsApolloOptionsFunction): Observable<ApolloOptions> {
    return Observable.of(null).concatMap(() => {
        if (isOptionsFunction(options)) {
            let promiseForOptions = Promise.resolve(ws).then(options);
            return Observable.fromPromise(promiseForOptions)
                .catch((e) => {
                    throw new Error(`Invalid options provided to ApolloServer: ${e.message}`);
                });
        } else {
            return Observable.of(options);
        }
    }).take(1); // Should be run once per client
}

export function wsApollo(options: ApolloOptions | WsApolloOptionsFunction): WsHandler {
    if (!options) {
        throw new Error('Apollo Server requires options.');
    }

    if (arguments.length > 1) {
        throw new Error(`Apollo Server expects exactly one argument, got ${arguments.length}`);
    }

    return (ws): void => {
        let requests = {};
        // Initially, handle options.
        let options$: Observable<ApolloOptions> = ObservableFromOptions(ws, options);
        // Next, convert websocket into a stream.
        let messageStream$: Observable<WsMessageParams> = ObservableFromWs(ws);
        // Finally, merge between the two
        let combined$ = Observable.combineLatest(messageStream$, options$)
            .map(([message, opts]) => ({
                    apolloOptions: opts,
                    flags: message.flags,
                    requestParams: message.requestParams,
            }));

            combined$.subscribe(({apolloOptions, requestParams}) => {
                const formatErrorFn = apolloOptions.formatError || graphql.formatError;

                if (Array.isArray(requestParams)) {
                    return Observable.of({ errors: ['Does not support batching'] });
                }

                const reqId = requestParams.id;
                if ( undefined === reqId ) {
                    return Observable.of({ errors: ['Missing request id'] });
                }

                if ( requests.hasOwnProperty(reqId) ) {
                    requests[reqId].unsubscribe();
                    delete requests[reqId];
                }
                if ( requestParams.operationName && requestParams.operationName === 'cancel' ) {
                    return Observable.empty();
                }

                requests[reqId] = Observable.of(null).flatMap(() => {
                    const query = requestParams.query;
                    const operationName = requestParams.operationName;
                    let variables = requestParams.variables;

                    if (typeof variables === 'string') {
                        try {
                            variables = JSON.parse(variables);
                        } catch (error) {
                            throw new Error('Variables are invalid JSON.');
                        }
                    }

                    let params = {
                        schema: apolloOptions.schema,
                        query: query,
                        variables: variables,
                        context: apolloOptions.context,
                        rootValue: apolloOptions.rootValue,
                        operationName: operationName,
                        logFunction: apolloOptions.logFunction,
                        validationRules: apolloOptions.validationRules,
                        formatError: formatErrorFn,
                        formatResponse: apolloOptions.formatResponse,
                        debug: apolloOptions.debug,
                    };

                    if (apolloOptions.formatParams) {
                        params = apolloOptions.formatParams(params);
                    }

                    return runQueryReactive(params);
            })
            .catch((e) => {
                return Observable.of({ errors: [formatErrorFn(e)] });
            })
            .toDiff().map((result) => {
                if (undefined === reqId) {
                    return result;
                }

                return Object.assign({}, result, {
                    id: reqId,
                });
            }).subscribe((x) => ws.send(JSON.stringify(x)));
        }, (e) => {
            // Log the error and disconnect client.
            ws.send(e.message);
            ws.close();
        }, () => {
            // Unsubscribe when socket disconnects.
            Object.keys(requests).forEach((k) => {
                requests[k].unsubscribe();
                delete requests[k];
            });
        });
    };
}
