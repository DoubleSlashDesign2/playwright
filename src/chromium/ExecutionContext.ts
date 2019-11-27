/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CDPSession } from './Connection';
import { helper } from '../helper';
import { valueFromRemoteObject, getExceptionMessage, releaseObject } from './protocolHelper';
import { createJSHandle, ElementHandle } from './JSHandle';
import { Protocol } from './protocol';
import * as js from '../javascript';

export const EVALUATION_SCRIPT_URL = '__playwright_evaluation_script__';
const SOURCE_URL_REGEX = /^[\040\t]*\/\/[@#] sourceURL=\s*(\S*?)\s*$/m;

export type ExecutionContext = js.ExecutionContext<ElementHandle>;
export type JSHandle = js.JSHandle<ElementHandle>;

export class ExecutionContextDelegate implements js.ExecutionContextDelegate<ElementHandle> {
  _client: CDPSession;
  _contextId: number;

  constructor(client: CDPSession, contextPayload: Protocol.Runtime.ExecutionContextDescription) {
    this._client = client;
    this._contextId = contextPayload.id;
  }

  async evaluate(context: ExecutionContext, returnByValue: boolean, pageFunction: Function | string, ...args: any[]): Promise<any> {
    const suffix = `//# sourceURL=${EVALUATION_SCRIPT_URL}`;

    if (helper.isString(pageFunction)) {
      const contextId = this._contextId;
      const expression: string = pageFunction as string;
      const expressionWithSourceUrl = SOURCE_URL_REGEX.test(expression) ? expression : expression + '\n' + suffix;
      const {exceptionDetails, result: remoteObject} = await this._client.send('Runtime.evaluate', {
        expression: expressionWithSourceUrl,
        contextId,
        returnByValue,
        awaitPromise: true,
        userGesture: true
      }).catch(rewriteError);
      if (exceptionDetails)
        throw new Error('Evaluation failed: ' + getExceptionMessage(exceptionDetails));
      return returnByValue ? valueFromRemoteObject(remoteObject) : createJSHandle(context, remoteObject);
    }

    if (typeof pageFunction !== 'function')
      throw new Error(`Expected to get |string| or |function| as the first argument, but got "${pageFunction}" instead.`);

    let functionText = pageFunction.toString();
    try {
      new Function('(' + functionText + ')');
    } catch (e1) {
      // This means we might have a function shorthand. Try another
      // time prefixing 'function '.
      if (functionText.startsWith('async '))
        functionText = 'async function ' + functionText.substring('async '.length);
      else
        functionText = 'function ' + functionText;
      try {
        new Function('(' + functionText  + ')');
      } catch (e2) {
        // We tried hard to serialize, but there's a weird beast here.
        throw new Error('Passed function is not well-serializable!');
      }
    }
    let callFunctionOnPromise;
    try {
      callFunctionOnPromise = this._client.send('Runtime.callFunctionOn', {
        functionDeclaration: functionText + '\n' + suffix + '\n',
        executionContextId: this._contextId,
        arguments: args.map(convertArgument.bind(this)),
        returnByValue,
        awaitPromise: true,
        userGesture: true
      });
    } catch (err) {
      if (err instanceof TypeError && err.message.startsWith('Converting circular structure to JSON'))
        err.message += ' Are you passing a nested JSHandle?';
      throw err;
    }
    const { exceptionDetails, result: remoteObject } = await callFunctionOnPromise.catch(rewriteError);
    if (exceptionDetails)
      throw new Error('Evaluation failed: ' + getExceptionMessage(exceptionDetails));
    return returnByValue ? valueFromRemoteObject(remoteObject) : createJSHandle(context, remoteObject);

    function convertArgument(arg: any): any {
      if (typeof arg === 'bigint') // eslint-disable-line valid-typeof
        return { unserializableValue: `${arg.toString()}n` };
      if (Object.is(arg, -0))
        return { unserializableValue: '-0' };
      if (Object.is(arg, Infinity))
        return { unserializableValue: 'Infinity' };
      if (Object.is(arg, -Infinity))
        return { unserializableValue: '-Infinity' };
      if (Object.is(arg, NaN))
        return { unserializableValue: 'NaN' };
      const objectHandle = arg && (arg instanceof js.JSHandle) ? arg : null;
      if (objectHandle) {
        if (objectHandle._context !== context)
          throw new Error('JSHandles can be evaluated only in the context they were created!');
        if (objectHandle._disposed)
          throw new Error('JSHandle is disposed!');
        const remoteObject = toRemoteObject(objectHandle);
        if (remoteObject.unserializableValue)
          return { unserializableValue: remoteObject.unserializableValue };
        if (!remoteObject.objectId)
          return { value: remoteObject.value };
        return { objectId: remoteObject.objectId };
      }
      return { value: arg };
    }

    function rewriteError(error: Error): Protocol.Runtime.evaluateReturnValue {
      if (error.message.includes('Object reference chain is too long'))
        return {result: {type: 'undefined'}};
      if (error.message.includes('Object couldn\'t be returned by value'))
        return {result: {type: 'undefined'}};

      if (error.message.endsWith('Cannot find context with specified id') || error.message.endsWith('Inspected target navigated or closed'))
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
      throw error;
    }
  }

  async adoptBackendNodeId(context: ExecutionContext, backendNodeId: Protocol.DOM.BackendNodeId) {
    const {object} = await this._client.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId: this._contextId,
    });
    return createJSHandle(context, object) as ElementHandle;
  }

  async getProperties(handle: JSHandle): Promise<Map<string, JSHandle>> {
    const response = await this._client.send('Runtime.getProperties', {
      objectId: toRemoteObject(handle).objectId,
      ownProperties: true
    });
    const result = new Map();
    for (const property of response.result) {
      if (!property.enumerable)
        continue;
      result.set(property.name, createJSHandle(handle.executionContext(), property.value));
    }
    return result;
  }

  async releaseHandle(handle: JSHandle): Promise<void> {
    await releaseObject(this._client, toRemoteObject(handle));
  }

  async handleJSONValue(handle: JSHandle): Promise<any> {
    const remoteObject = toRemoteObject(handle);
    if (remoteObject.objectId) {
      const response = await this._client.send('Runtime.callFunctionOn', {
        functionDeclaration: 'function() { return this; }',
        objectId: remoteObject.objectId,
        returnByValue: true,
        awaitPromise: true,
      });
      return valueFromRemoteObject(response.result);
    }
    return valueFromRemoteObject(remoteObject);
  }

  handleToString(handle: JSHandle): string {
    const object = toRemoteObject(handle);
    if (object.objectId) {
      const type =  object.subtype || object.type;
      return 'JSHandle@' + type;
    }
    return 'JSHandle:' + valueFromRemoteObject(object);
  }
}

const remoteObjectSymbol = Symbol('RemoteObject');

export function toRemoteObject(handle: JSHandle): Protocol.Runtime.RemoteObject {
  return (handle as any)[remoteObjectSymbol];
}

export function markJSHandle(handle: JSHandle, remoteObject: Protocol.Runtime.RemoteObject) {
  (handle as any)[remoteObjectSymbol] = remoteObject;
}
