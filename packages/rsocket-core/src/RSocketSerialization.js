/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

import type {Encodable} from './RSocketTypes';

import ByteBuffer from 'bytebuffer';
import invariant from 'fbjs/lib/invariant';

/**
 * A Serializer transforms data between the application encoding used in
 * Payloads and the Encodable type accepted by the transport client.
 */
export type Serializer<T> = {|
  deserialize: (data: ?Encodable) => ?T,
  serialize: (data: ?T) => ?Encodable,
|};

// JSON serializer
export const JsonSerializer: Serializer<*> = {
  deserialize: data => {
    let str;
    if (data == null) {
      return null;
    } else if (typeof data === 'string') {
      str = data;
    } else if (ByteBuffer.isByteBuffer(data)) {
      str = (data: any).toString('utf8');
    } else {
      const buffer = ByteBuffer.wrap(data);
      str = buffer.toString('utf8');
    }
    return JSON.parse(str);
  },
  serialize: JSON.stringify,
};

export const JsonSerializers = {
  data: JsonSerializer,
  metadata: JsonSerializer,
};

// Pass-through serializer
export const IdentitySerializer: Serializer<Encodable> = {
  deserialize: data => {
    invariant(
      data == null ||
        typeof data === 'string' ||
        ByteBuffer.isByteBuffer(data) ||
        data instanceof Uint8Array,
      'RSocketSerialization: Expected data to be a string, Buffer, or ' +
        'Uint8Array. Got `%s`.',
      data,
    );
    return data;
  },
  serialize: data => data,
};

export const IdentitySerializers = {
  data: IdentitySerializer,
  metadata: IdentitySerializer,
};
