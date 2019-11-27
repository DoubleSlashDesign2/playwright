/**
 * Copyright 2019 Google Inc. All rights reserved.
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

import { assert, debugError, helper } from '../helper';
import Injected from '../injected/injected';
import * as input from '../input';
import * as types from '../types';
import * as js from '../javascript';
import { CDPSession } from './Connection';
import { Frame } from './FrameManager';
import { FrameManager } from './FrameManager';
import { Page } from './Page';
import { Protocol } from './protocol';
import { JSHandle, ExecutionContext, ExecutionContextDelegate, markJSHandle } from './ExecutionContext';

type SelectorRoot = Element | ShadowRoot | Document;

type Point = {
  x: number;
  y: number;
};

export function createJSHandle(context: ExecutionContext, remoteObject: Protocol.Runtime.RemoteObject): JSHandle {
  const delegate = context._delegate as ExecutionContextDelegate;
  const frame = context.frame();
  if (remoteObject.subtype === 'node' && frame) {
    const frameManager = frame._delegate as FrameManager;
    return new ElementHandle(context, delegate._client, remoteObject, frameManager.page(), frameManager);
  }
  const handle = new js.JSHandle(context);
  markJSHandle(handle, remoteObject);
  return handle;
}

export class ElementHandle extends js.JSHandle<ElementHandle> {
  private _client: CDPSession;
  private _remoteObject: Protocol.Runtime.RemoteObject;
  private _page: Page;
  private _frameManager: FrameManager;

  constructor(context: ExecutionContext, client: CDPSession, remoteObject: Protocol.Runtime.RemoteObject, page: Page, frameManager: FrameManager) {
    super(context);
    this._client = client;
    this._remoteObject = remoteObject;
    this._page = page;
    this._frameManager = frameManager;
    markJSHandle(this, remoteObject);
  }

  asElement(): ElementHandle | null {
    return this;
  }

  async contentFrame(): Promise<Frame|null> {
    const nodeInfo = await this._client.send('DOM.describeNode', {
      objectId: this._remoteObject.objectId
    });
    if (typeof nodeInfo.node.frameId !== 'string')
      return null;
    return this._frameManager.frame(nodeInfo.node.frameId);
  }

  async _scrollIntoViewIfNeeded() {
    const error = await this.evaluate(async (element, pageJavascriptEnabled) => {
      if (!element.isConnected)
        return 'Node is detached from document';
      if (element.nodeType !== Node.ELEMENT_NODE)
        return 'Node is not of type HTMLElement';
      // force-scroll if page's javascript is disabled.
      if (!pageJavascriptEnabled) {
        element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
        return false;
      }
      const visibleRatio = await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          resolve(entries[0].intersectionRatio);
          observer.disconnect();
        });
        observer.observe(element);
      });
      if (visibleRatio !== 1.0)
        element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      return false;
    }, this._page._javascriptEnabled);
    if (error)
      throw new Error(error);
  }

  async _clickablePoint(): Promise<Point> {
    const [result, layoutMetrics] = await Promise.all([
      this._client.send('DOM.getContentQuads', {
        objectId: this._remoteObject.objectId
      }).catch(debugError),
      this._client.send('Page.getLayoutMetrics'),
    ]);
    if (!result || !result.quads.length)
      throw new Error('Node is either not visible or not an HTMLElement');
    // Filter out quads that have too small area to click into.
    const {clientWidth, clientHeight} = layoutMetrics.layoutViewport;
    const quads = result.quads.map(quad => this._fromProtocolQuad(quad)).map(quad => this._intersectQuadWithViewport(quad, clientWidth, clientHeight)).filter(quad => computeQuadArea(quad) > 1);
    if (!quads.length)
      throw new Error('Node is either not visible or not an HTMLElement');
    // Return the middle point of the first quad.
    const quad = quads[0];
    let x = 0;
    let y = 0;
    for (const point of quad) {
      x += point.x;
      y += point.y;
    }
    return {
      x: x / 4,
      y: y / 4
    };
  }

  async _viewportPointAndScroll(relativePoint: Point): Promise<{point: Point, scrollX: number, scrollY: number}> {
    const model = await this._getBoxModel();
    let point: Point;
    if (!model) {
      point = relativePoint;
    } else {
      // Use padding quad to be compatible with offsetX/offsetY properties.
      const quad = model.model.padding;
      const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
      const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
      point = {
        x: x + relativePoint.x,
        y: y + relativePoint.y,
      };
    }
    const metrics = await this._client.send('Page.getLayoutMetrics');
    // Give one extra pixel to avoid any issues on viewport edge.
    let scrollX = 0;
    if (point.x < 1)
      scrollX = point.x - 1;
    if (point.x > metrics.layoutViewport.clientWidth - 1)
      scrollX = point.x - metrics.layoutViewport.clientWidth + 1;
    let scrollY = 0;
    if (point.y < 1)
      scrollY = point.y - 1;
    if (point.y > metrics.layoutViewport.clientHeight - 1)
      scrollY = point.y - metrics.layoutViewport.clientHeight + 1;
    return { point, scrollX, scrollY };
  }

  async _performPointerAction(action: (point: Point) => Promise<void>, options?: input.PointerActionOptions): Promise<void> {
    await this._scrollIntoViewIfNeeded();
    let point: Point;
    if (options && options.relativePoint) {
      let r = await this._viewportPointAndScroll(options.relativePoint);
      if (r.scrollX || r.scrollY) {
        const error = await this.evaluate((element, scrollX, scrollY) => {
          if (!element.ownerDocument || !element.ownerDocument.defaultView)
            return 'Node does not have a containing window';
          element.ownerDocument.defaultView.scrollBy(scrollX, scrollY);
          return false;
        }, r.scrollX, r.scrollY);
        if (error)
          throw new Error(error);
        r = await this._viewportPointAndScroll(options.relativePoint);
        if (r.scrollX || r.scrollY)
          throw new Error('Failed to scroll relative point into viewport');
      }
      point = r.point;
    } else {
      await this._scrollIntoViewIfNeeded();
      point = await this._clickablePoint();
    }
    let restoreModifiers: input.Modifier[] | undefined;
    if (options && options.modifiers)
      restoreModifiers = await this._page.keyboard._ensureModifiers(options.modifiers);
    await action(point);
    if (restoreModifiers)
      await this._page.keyboard._ensureModifiers(restoreModifiers);
  }

  _getBoxModel(): Promise<void | Protocol.DOM.getBoxModelReturnValue> {
    return this._client.send('DOM.getBoxModel', {
      objectId: this._remoteObject.objectId
    }).catch(error => debugError(error));
  }

  _fromProtocolQuad(quad: number[]): Array<{ x: number; y: number; }> {
    return [
      {x: quad[0], y: quad[1]},
      {x: quad[2], y: quad[3]},
      {x: quad[4], y: quad[5]},
      {x: quad[6], y: quad[7]}
    ];
  }

  _intersectQuadWithViewport(quad: Array<{ x: number; y: number; }>, width: number, height: number): Array<{ x: number; y: number; }> {
    return quad.map(point => ({
      x: Math.min(Math.max(point.x, 0), width),
      y: Math.min(Math.max(point.y, 0), height),
    }));
  }

  hover(options?: input.PointerActionOptions): Promise<void> {
    return this._performPointerAction(point => this._page.mouse.move(point.x, point.y), options);
  }

  click(options?: input.ClickOptions): Promise<void> {
    return this._performPointerAction(point => this._page.mouse.click(point.x, point.y, options), options);
  }

  dblclick(options?: input.MultiClickOptions): Promise<void> {
    return this._performPointerAction(point => this._page.mouse.dblclick(point.x, point.y, options), options);
  }

  tripleclick(options?: input.MultiClickOptions): Promise<void> {
    return this._performPointerAction(point => this._page.mouse.tripleclick(point.x, point.y, options), options);
  }

  async select(...values: (string | ElementHandle | input.SelectOption)[]): Promise<string[]> {
    const options = values.map(value => typeof value === 'object' ? value : { value });
    for (const option of options) {
      if (option instanceof ElementHandle)
        continue;
      if (option.value !== undefined)
        assert(helper.isString(option.value), 'Values must be strings. Found value "' + option.value + '" of type "' + (typeof option.value) + '"');
      if (option.label !== undefined)
        assert(helper.isString(option.label), 'Labels must be strings. Found label "' + option.label + '" of type "' + (typeof option.label) + '"');
      if (option.index !== undefined)
        assert(helper.isNumber(option.index), 'Indices must be numbers. Found index "' + option.index + '" of type "' + (typeof option.index) + '"');
    }
    return this.evaluate(input.selectFunction, ...options);
  }

  async fill(value: string): Promise<void> {
    assert(helper.isString(value), 'Value must be string. Found value "' + value + '" of type "' + (typeof value) + '"');
    const error = await this.evaluate(input.fillFunction);
    if (error)
      throw new Error(error);
    await this.focus();
    await this._page.keyboard.sendCharacters(value);
  }

  async setInputFiles(...files: (string|input.FilePayload)[]) {
    const multiple = await this.evaluate((element: HTMLInputElement) => !!element.multiple);
    assert(multiple || files.length <= 1, 'Non-multiple file input can only accept single file!');
    await this.evaluate(input.setFileInputFunction, await input.loadFiles(files));
  }

  async focus() {
    await this.evaluate(element => element.focus());
  }

  async type(text: string, options: { delay: (number | undefined); } | undefined) {
    await this.focus();
    await this._page.keyboard.type(text, options);
  }

  async press(key: string, options: { delay?: number; text?: string; } | undefined) {
    await this.focus();
    await this._page.keyboard.press(key, options);
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number; } | null> {
    const result = await this._getBoxModel();

    if (!result)
      return null;

    const quad = result.model.border;
    const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
    const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
    const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
    const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;

    return {x, y, width, height};
  }

  async screenshot(options: any = {}): Promise<string | Buffer> {
    let needsViewportReset = false;

    let boundingBox = await this.boundingBox();
    assert(boundingBox, 'Node is either not visible or not an HTMLElement');

    const viewport = this._page.viewport();

    if (viewport && (boundingBox.width > viewport.width || boundingBox.height > viewport.height)) {
      const newViewport = {
        width: Math.max(viewport.width, Math.ceil(boundingBox.width)),
        height: Math.max(viewport.height, Math.ceil(boundingBox.height)),
      };
      await this._page.setViewport(Object.assign({}, viewport, newViewport));

      needsViewportReset = true;
    }

    await this._scrollIntoViewIfNeeded();

    boundingBox = await this.boundingBox();
    assert(boundingBox, 'Node is either not visible or not an HTMLElement');
    assert(boundingBox.width !== 0, 'Node has 0 width.');
    assert(boundingBox.height !== 0, 'Node has 0 height.');

    const { layoutViewport: { pageX, pageY } } = await this._client.send('Page.getLayoutMetrics');

    const clip = Object.assign({}, boundingBox);
    clip.x += pageX;
    clip.y += pageY;

    const imageData = await this._page.screenshot(Object.assign({}, {
      clip
    }, options));

    if (needsViewportReset)
      await this._page.setViewport(viewport);

    return imageData;
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const handle = await this.evaluateHandle(
        (root: SelectorRoot, selector: string, injected: Injected) => injected.querySelector('css=' + selector, root),
        selector, await this._context._injected()
    );
    const element = handle.asElement();
    if (element)
      return element;
    await handle.dispose();
    return null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const arrayHandle = await this.evaluateHandle(
        (root: SelectorRoot, selector: string, injected: Injected) => injected.querySelectorAll('css=' + selector, root),
        selector, await this._context._injected()
    );
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();
    const result = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement();
      if (elementHandle)
        result.push(elementHandle);
    }
    return result;
  }

  $eval: types.$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const elementHandle = await this.$(selector);
    if (!elementHandle)
      throw new Error(`Error: failed to find element matching selector "${selector}"`);
    const result = await elementHandle.evaluate(pageFunction, ...args as any);
    await elementHandle.dispose();
    return result;
  }

  $$eval: types.$$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const arrayHandle = await this.evaluateHandle(
        (root: SelectorRoot, selector: string, injected: Injected) => injected.querySelectorAll('css=' + selector, root),
        selector, await this._context._injected()
    );

    const result = await arrayHandle.evaluate(pageFunction, ...args as any);
    await arrayHandle.dispose();
    return result;
  }

  async $x(expression: string): Promise<ElementHandle[]> {
    const arrayHandle = await this.evaluateHandle(
        (root: SelectorRoot, expression: string, injected: Injected) => injected.querySelectorAll('xpath=' + expression, root),
        expression, await this._context._injected()
    );
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();
    const result = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement();
      if (elementHandle)
        result.push(elementHandle);
    }
    return result;
  }

  isIntersectingViewport(): Promise<boolean> {
    return this.evaluate(async element => {
      const visibleRatio = await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          resolve(entries[0].intersectionRatio);
          observer.disconnect();
        });
        observer.observe(element);
      });
      return visibleRatio > 0;
    });
  }
}

function computeQuadArea(quad) {
  // Compute sum of all directed areas of adjacent triangles
  // https://en.wikipedia.org/wiki/Polygon#Simple_polygons
  let area = 0;
  for (let i = 0; i < quad.length; ++i) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % quad.length];
    area += (p1.x * p2.y - p2.x * p1.y) / 2;
  }
  return Math.abs(area);
}
