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
 * Commonly used subset of the allowed Node Buffer Encoder types.
 */
export type Encoder<T: Encodable> = {|
  byteLength: (value: Encodable) => number,
  encode: (
    value: Encodable,
    buffer: ByteBuffer,
    offset: number,
  ) => number,
  decode: (buffer: ByteBuffer, start: number, end: number) => T,
|};

/**
 * The Encoders object specifies how values should be serialized/deserialized
 * to/from binary.
 */
export type Encoders<T: Encodable> = {|
  data: Encoder<T>,
  dataMimeType: Encoder<string>,
  message: Encoder<string>,
  metadata: Encoder<T>,
  metadataMimeType: Encoder<string>,
  resumeToken: Encoder<T>,
|};

export const UTF8Encoder: Encoder<string> = {
  byteLength: (value: Encodable) => {
    invariant(
      typeof value === 'string',
      'RSocketEncoding: Expected value to be a string, got `%s`.',
      value,
    );
    return ByteBuffer.calculateUTF8Bytes(value);
  },
  decode: (buffer: ByteBuffer, start: number, end: number): string => {
    return buffer.slice(start, end).toUTF8();
  },
  encode: (
    value: Encodable,
    buffer: ByteBuffer,
    offset: number,
  ): number => {
    invariant(
      typeof value === 'string',
      'RSocketEncoding: Expected value to be a string, got `%s`.',
      value,
    );
    const length: any = buffer.writeUTF8String(value, offset);
    return offset + length;
  },
};

export const BufferEncoder: Encoder<ByteBuffer> = {
  byteLength: (value: any) => {
    invariant(
      ByteBuffer.isByteBuffer(value),
      'RSocketEncoding: Expected value to be a buffer, got `%s`.',
      value,
    );
    return value.limit;
  },
  decode: (buffer: ByteBuffer, start: number, end: number): ByteBuffer => {
    return buffer.slice(start, end);
  },
  encode: (
    value: any,
    buffer: ByteBuffer,
    offset: number,
  ): number => {
    invariant(
      ByteBuffer.isByteBuffer(value),
      'RSocketEncoding: Expected value to be a buffer, got `%s`.',
      value,
    );
    value.copyTo(buffer, offset, 0, value.limit);
    return offset + value.limit;
  },
};

/**
 * Encode all values as UTF8 strings.
 */
export const Utf8Encoders: Encoders<string> = {
  data: UTF8Encoder,
  dataMimeType: UTF8Encoder,
  message: UTF8Encoder,
  metadata: UTF8Encoder,
  metadataMimeType: UTF8Encoder,
  resumeToken: UTF8Encoder,
};

/**
 * Encode all values as buffers.
 */
export const BufferEncoders: Encoders<ByteBuffer> = {
  data: BufferEncoder,
  dataMimeType: UTF8Encoder,
  message: UTF8Encoder,
  metadata: BufferEncoder,
  metadataMimeType: UTF8Encoder,
  resumeToken: BufferEncoder,
};
