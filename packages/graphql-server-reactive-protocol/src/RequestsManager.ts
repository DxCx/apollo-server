import {
  ReactiveGraphQLOptions,
  ReactiveQueryOptions,
  RGQLExecuteFunction ,
  runQueryReactive,
} from 'graphql-server-reactive-core';

import {
  IObservable,
  Observer,
  Observable,
  Subscription,
} from 'graphql-server-observable';

import { formatError, ExecutionResult } from 'graphql';

import {
  RGQL_MSG_ERROR,
  RGQL_MSG_COMPLETE,
  RGQL_MSG_DATA,
  RGQL_MSG_START,
  RGQL_MSG_STOP,
  RGQL_MSG_INIT,
  RGQL_MSG_INIT_SUCCESS,
  RGQL_MSG_KEEPALIVE,
  RGQLPacket,
  RGQLPacketData,
  RGQLPayloadStart,
} from './messageTypes';

export interface RequestHooks {
  onRequestStart?: (requestId: number, queryOptions: ReactiveQueryOptions) => ReactiveQueryOptions | Promise<ReactiveQueryOptions>;
  onRequestStop?: (requestId: number) => void | Promise<void>;
  onInit?: (initPayload: any) => boolean | Promise<boolean>;
  onDisconnect?: () => void | Promise<void>;
}

export class RequestsManager {
  protected requests: { [key: number]: Subscription } = {};
  protected orphanedResponses: Subscription[] = [];
  protected _responseObservable: IObservable<RGQLPacket>;
  protected executeReactive: RGQLExecuteFunction;

  constructor(protected graphqlOptions: ReactiveGraphQLOptions,
              requestObservable: IObservable<RGQLPacket>,
              protected hooks: RequestHooks = {}) {
      this._responseObservable = new Observable((observer) => {
        const kaSub = this._keepAliveObservable().subscribe({
          next: (packet) => observer.next(packet),
          error: observer.error,
          complete: () => { /* noop */ },
        });
        const sub = requestObservable.subscribe({
          next: (request) => this._handleRequest(request, observer),
          error: observer.error,
          complete: () => {
            this.onDisconnect()
            .then(() => undefined, (e) => {
              console.error('onDisconnect failed:', e);
              return undefined;
            })
            .then(observer.complete);
          },
        });

        return () => {
          this._unsubscribeAll()
          .then(() => {
            /* istanbul ignore else */
            if ( kaSub ) {
              kaSub.unsubscribe();
            }
            /* istanbul ignore else */
            if ( sub ) {
              sub.unsubscribe();
            }
          }, (e) => {
            console.error('protocol unsubscribe error:', e);
          });
        };
      });

      this.executeReactive = graphqlOptions.executor.executeReactive.bind(graphqlOptions.executor);
  }

  public get responseObservable(): IObservable<RGQLPacket> {
    // XXX: Need to wrap with multicast.
    return this._responseObservable;
  }

  protected _handleRequest(request: RGQLPacket, onMessageObserver: Observer<RGQLPacket>) {
    this._subscribeResponse(this._executeRequest(request.data), request, onMessageObserver);
  }

  protected _keepAliveObservable(): Observable<RGQLPacket> {
    const keepAlive: number = this.graphqlOptions.keepAlive;

    if ( ! keepAlive ) {
      return Observable.empty();
    }

    return new Observable((observer) => {
      const kaInterval = setInterval(() => {
        observer.next({ data: { type: RGQL_MSG_KEEPALIVE } });
      }, keepAlive);

      return () => {
        clearInterval(kaInterval);
      };
    });
  }

  protected _executeRequest(request: RGQLPacketData): IObservable<RGQLPacketData> {
    try {
      this._validateRequest(request);
    } catch (e) {
      return Observable.throw(e);
    }

    const key: number = request.id;
    switch ( request.type ) {
      case RGQL_MSG_STOP:
        return this.stopObservable(request.id);
      case RGQL_MSG_INIT:
        return this.onInit(request.payload);
      case RGQL_MSG_START:
        return this._flattenObservableData(this._executeStart(request),
                                           request.id);
      /* istanbul ignore next: invalid case. */
      default:
        return Observable.throw(new Error('FATAL ERROR: type was overritten since validation'));
    }
  }

  protected _executeStart(request: RGQLPacketData): IObservable<ExecutionResult> {
    const formatErrorFn = this.graphqlOptions.formatError || formatError;
    const graphqlRequest: RGQLPayloadStart = request.payload;
    const query = graphqlRequest.query;
    const operationName = graphqlRequest.operationName;
    let variables = graphqlRequest.variables;

    this._unsubscribe(request.id);
    if (typeof variables === 'string') {
      try {
        variables = JSON.parse(variables);
      } catch (error) {
        return Observable.throw(new Error('Variables are invalid JSON.'));
      }
    }

    let params: ReactiveQueryOptions = {
      schema: this.graphqlOptions.schema,
      query: query,
      variables: variables,
      context: this.graphqlOptions.context,
      rootValue: this.graphqlOptions.rootValue,
      operationName: operationName,
      logFunction: this.graphqlOptions.logFunction,
      validationRules: this.graphqlOptions.validationRules,
      formatError: formatErrorFn,
      formatResponse: this.graphqlOptions.formatResponse,
      debug: this.graphqlOptions.debug,
      executeReactive: this.executeReactive,
    };

    return new Observable((observer) => {
      const subscriptionPromise = this.onRequestStart(request.id, params)
        .then((options) => {
          if (this.graphqlOptions.formatParams) {
            return this.graphqlOptions.formatParams(options);
          }

          return options;
        })
        .then((options) => runQueryReactive(options).subscribe(observer))
        .then(undefined, (e) => {
            observer.error(e);
            return undefined;
        });

      return () => {
        subscriptionPromise.then((resultSubscription) => {
          if ( resultSubscription ) {
            resultSubscription.unsubscribe();
          }
        });
      };
    });
  }

  protected _subscribeResponse(obs: IObservable<RGQLPacketData>, request: RGQLPacket, onMessageObserver: Observer<RGQLPacket>): void {
    const key: number = request.data.id;
    const responseSubscription = this._prepareResponseStream(obs, key, request.metadata).subscribe(onMessageObserver);

    if ( key ) {
      this.requests[key] = responseSubscription;
    } else {
      this.orphanedResponses.push(responseSubscription);
    }
  }

  protected _validateRequest(packet: RGQLPacketData) {
    if ( undefined === packet.type ) {
      throw new Error('Request is missing type field');
    }

    switch ( packet.type ) {
      case RGQL_MSG_START:
        if ( undefined === packet.id ) {
          throw new Error('Request is missing id field');
        }

        if ( undefined === packet.payload ) {
          throw new Error('Request is missing payload field');
        }
        if (Array.isArray(packet.payload)) {
          throw new Error('interface does does not support batching');
        }
        if ( undefined === (<RGQLPayloadStart> packet.payload).query ) {
          throw new Error('Request is missing payload.query field');
        }
        return;
      case RGQL_MSG_STOP:
        if ( undefined === packet.id ) {
          throw new Error('Request is missing id field');
        }

        // Nothing much to check, no payload.
        return;
      case RGQL_MSG_INIT:
        // payload is optional.
        return;
      default:
        throw new Error('Request has invalid type');
    }
  }

  protected _prepareResponseStream(obs: IObservable<ExecutionResult>, key: number, metadata?: Object): IObservable<RGQLPacket> {
    return new Observable((observer) => {
      return this._flattenObservableErrors(obs, key).subscribe({
        next: (data: RGQLPacketData) => {
          // data => packet (data + metadata)
          const nextData = {
            data,
            ...(metadata ? { metadata } : {}),
          };

          observer.next(nextData);
        },
        error: observer.error,
        complete: () => { /* noop */ },
      });
    });
  }

  protected _flattenObservableData(obs: IObservable<ExecutionResult>, id?: number): IObservable<RGQLPacketData> {
    return new Observable((observer) => {
      return obs.subscribe({
        next: (data) => {
          observer.next({
            id,
            type: RGQL_MSG_DATA,
            payload: data,
          });
        },
        error: (e) => observer.error(e),
        complete: () => {
          this.onRequestStop(id).then(() => {
            observer.next({
              id,
              type: RGQL_MSG_COMPLETE,
            });
          }, (e) => observer.error(e));
        },
      });
    });
  }

  protected _flattenObservableErrors(obs: IObservable<RGQLPacketData>, id?: number): IObservable<RGQLPacketData> {
    return new Observable((observer) => {
      return obs.subscribe({
        next: (v) => observer.next(v),
        error: (e) => {
          observer.next({
            ...((undefined !== id) ? { id } : {}),
            type: RGQL_MSG_ERROR,
            payload: e,
          });
        },
        complete: () => observer.complete(),
      });
    });
  }

  protected _unsubscribeAll(): Promise<void> {
    const promises = Object.keys(this.requests).map((k) => {
      return this._unsubscribe(parseInt(k, 10));
    });

    return Promise.all(promises)
    .then(() => {
      while ( this.orphanedResponses.length > 0 ) {
        this.orphanedResponses.pop().unsubscribe();
      }
    });
  }

  protected stopObservable(key: number): IObservable<RGQLPacketData> {
    return new Observable((observer) => {
      this._unsubscribe(key)
        .then(() => observer.complete(), observer.error);
        return () => { /* noop */ };
    });
  }

  protected _unsubscribe(key: number): Promise<void> {
    if ( this.requests.hasOwnProperty(key) ) {
      this.requests[key].unsubscribe();
      delete this.requests[key];
      return this.onRequestStop(key);
    }

    return Promise.resolve();
  }

  protected onRequestStart(requestId: number, queryOptions: ReactiveQueryOptions): Promise<ReactiveQueryOptions> {
    if ( typeof this.hooks.onRequestStart !== 'function' ) {
      return Promise.resolve(queryOptions);
    }
    return Promise.resolve()
      .then(() => this.hooks.onRequestStart(requestId, queryOptions))
      .then((newOptions: ReactiveQueryOptions) => {
        if ( typeof newOptions !== 'object' ) {
          throw new Error('Invalid params returned from onRequestStart');
        }
        return newOptions;
      });
  }

  protected onRequestStop(requestId: number): Promise<void> {
    if ( typeof this.hooks.onRequestStop !== 'function' ) {
      return Promise.resolve();
    }

    return Promise.resolve()
      .then(() => this.hooks.onRequestStop(requestId));
  }

  protected onInit(initPayload: any): Observable<RGQLPacketData> {
    const successMsg = { type: RGQL_MSG_INIT_SUCCESS };
    if ( typeof this.hooks.onInit !== 'function' ) {
      return Observable.of(successMsg);
    }

    return new Observable((observer) => {
      Promise.resolve()
      .then(() => this.hooks.onInit(initPayload))
      .then((approved) => {
        if ( false === approved ) {
          throw new Error('Prohibited connection!');
        }

        return successMsg;
      })
      .then((result) => {
        observer.next(result);
        observer.complete();
      },
      (e) => observer.error(e));

      return () => { /* noop */ };
    });
  }

  protected onDisconnect(): Promise<void> {
    if ( typeof this.hooks.onDisconnect !== 'function' ) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve()
      .then(() => this.hooks.onDisconnect());
  }
}
