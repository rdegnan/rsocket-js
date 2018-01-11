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

/* eslint-disable no-bitwise */

/**
 * Read a uint24 from a buffer starting at the given offset.
 */
export function readUint24(buffer: ByteBuffer, offset: number): number {
  const val1 = buffer.readUint8(offset) << 16;
  const val2 = buffer.readUint8(offset + 1) << 8;
  const val3 = buffer.readUint8(offset + 2);
  return val1 | val2 | val3;
}

/**
 * Writes a uint24 to a buffer starting at the given offset, returning the
 * offset of the next byte.
 */
export function writeUint24(
  buffer: ByteBuffer,
  value: number,
  offset: number,
): ByteBuffer {
  buffer.writeUint8(value >>> 16, offset); // 3rd byte
  buffer.writeUint8(value >>> 8 & 0xff, offset + 1); // 2nd byte
  buffer.writeUint8(value & 0xff, offset + 2); // 1st byte
  return buffer;
}
