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

/* eslint-disable consistent-return, no-bitwise */

import type {
  CancelFrame,
  ErrorFrame,
  Frame,
  KeepAliveFrame,
  LeaseFrame,
  PayloadFrame,
  RequestChannelFrame,
  RequestFnfFrame,
  RequestNFrame,
  RequestResponseFrame,
  RequestStreamFrame,
  SetupFrame,
} from './RSocketTypes';
import type {Encoders} from './RSocketEncoding';

import invariant from 'fbjs/lib/invariant';
import {
  getFrameTypeName,
  isMetadata,
  FLAGS_MASK,
  FRAME_TYPE_OFFFSET,
  FRAME_TYPES,
  MAX_CODE,
  MAX_KEEPALIVE,
  MAX_LIFETIME,
  MAX_RESUME_LENGTH,
} from './RSocketFrame';
import {Utf8Encoders} from './RSocketEncoding';
import {
  readUint24,
  writeUint24,
} from './RSocketBufferUtils';
import ByteBuffer from 'bytebuffer';

type FrameWithPayload = {data: any, flags: number, metadata: any};

/**
 * Frame header is:
 * - stream id (uint32 = 4)
 * - type + flags (uint 16 = 2)
 */
const FRAME_HEADER_SIZE = 6;

/**
 * Size of frame length and metadata length fields.
 */
const UINT24_SIZE = 3;

/**
 * Reads a frame from a buffer that is prefixed with the frame length.
 */
export function deserializeFrameWithLength(
  buffer: ByteBuffer,
  encoders?: ?Encoders<*>,
): Frame {
  const frameLength = readUint24(buffer, 0);
  return deserializeFrame(
    buffer.slice(UINT24_SIZE, UINT24_SIZE + frameLength),
    encoders,
  );
}

/**
 * Given a buffer that may contain zero or more length-prefixed frames followed
 * by zero or more bytes of a (partial) subsequent frame, returns an array of
 * the frames and a buffer of the leftover bytes.
 */
export function deserializeFrames(
  buffer: ByteBuffer,
  encoders?: ?Encoders<*>,
): [Array<Frame>, ByteBuffer] {
  const frames = [];
  let offset = 0;
  while (offset + UINT24_SIZE < buffer.limit) {
    const frameLength = readUint24(buffer, offset);
    const frameStart = offset + UINT24_SIZE;
    const frameEnd = frameStart + frameLength;
    if (frameEnd > buffer.limit) {
      // not all bytes of next frame received
      break;
    }
    const frameBuffer = buffer.slice(frameStart, frameEnd);
    const frame = deserializeFrame(frameBuffer, encoders);
    frames.push(frame);
    offset = frameEnd;
  }
  return [frames, buffer.slice(offset, buffer.limit)];
}

/**
 * Writes a frame to a buffer with a length prefix.
 */
export function serializeFrameWithLength(
  frame: Frame,
  encoders?: ?Encoders<*>,
): ByteBuffer {
  const buffer = serializeFrame(frame, encoders);
  const lengthPrefixed = ByteBuffer.allocate(buffer.limit + UINT24_SIZE);
  writeUint24(lengthPrefixed, buffer.limit, 0);
  buffer.copyTo(lengthPrefixed, UINT24_SIZE, 0, buffer.limit);
  return lengthPrefixed;
}

/**
 * Read a frame from the buffer.
 */
export function deserializeFrame(
  buffer: ByteBuffer,
  encoders?: ?Encoders<*>,
): Frame {
  encoders = encoders || Utf8Encoders;
  let offset = 0;
  const streamId = buffer.readInt32(offset);
  offset += 4;
  invariant(
    streamId >= 0,
    'RSocketBinaryFraming: Invalid frame, expected a positive stream id, got `%s.',
    streamId,
  );
  const typeAndFlags = buffer.readUint16(offset);
  offset += 2;
  const type = typeAndFlags >>> FRAME_TYPE_OFFFSET; // keep highest 6 bits
  const flags = typeAndFlags & FLAGS_MASK; // keep lowest 10 bits
  switch (type) {
    case FRAME_TYPES.SETUP:
      return deserializeSetupFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.PAYLOAD:
      return deserializePayloadFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.ERROR:
      return deserializeErrorFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.KEEPALIVE:
      return deserializeKeepAliveFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.REQUEST_FNF:
      return deserializeRequestFnfFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.REQUEST_RESPONSE:
      return deserializeRequestResponseFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.REQUEST_STREAM:
      return deserializeRequestStreamFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.REQUEST_CHANNEL:
      return deserializeRequestChannelFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.REQUEST_N:
      return deserializeRequestNFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.CANCEL:
      return deserializeCancelFrame(buffer, streamId, flags, encoders);
    case FRAME_TYPES.LEASE:
      return deserializeLeaseFrame(buffer, streamId, flags, encoders);
    default:
      invariant(
        false,
        'RSocketBinaryFraming: Unsupported frame type `%s`.',
        getFrameTypeName(type),
      );
  }
}

/**
 * Convert the frame to a (binary) buffer.
 */
export function serializeFrame(frame: Frame, encoders?: ?Encoders<*>): ByteBuffer {
  encoders = encoders || Utf8Encoders;
  switch (frame.type) {
    case FRAME_TYPES.SETUP:
      return serializeSetupFrame(frame, encoders);
    case FRAME_TYPES.PAYLOAD:
      return serializePayloadFrame(frame, encoders);
    case FRAME_TYPES.ERROR:
      return serializeErrorFrame(frame, encoders);
    case FRAME_TYPES.KEEPALIVE:
      return serializeKeepAliveFrame(frame, encoders);
    case FRAME_TYPES.REQUEST_FNF:
    case FRAME_TYPES.REQUEST_RESPONSE:
      return serializeRequestFrame(frame, encoders);
    case FRAME_TYPES.REQUEST_STREAM:
    case FRAME_TYPES.REQUEST_CHANNEL:
      return serializeRequestManyFrame(frame, encoders);
    case FRAME_TYPES.REQUEST_N:
      return serializeRequestNFrame(frame, encoders);
    case FRAME_TYPES.CANCEL:
      return serializeCancelFrame(frame, encoders);
    case FRAME_TYPES.LEASE:
      return serializeLeaseFrame(frame, encoders);
    default:
      invariant(
        false,
        'RSocketBinaryFraming: Unsupported frame type `%s`.',
        getFrameTypeName(frame.type),
      );
  }
}

/**
 * Writes a SETUP frame into a new buffer and returns it.
 *
 * Prefix size is:
 * - version (2x uint16 = 4)
 * - keepalive (uint32 = 4)
 * - lifetime (uint32 = 4)
 * - resume token length (uint16 = 2)
 * - mime lengths (2x uint8 = 2)
 */
const SETUP_FIXED_SIZE = 16;
function serializeSetupFrame(frame: SetupFrame, encoders: Encoders<*>): ByteBuffer {
  const resumeTokenLength = frame.resumeToken != null
    ? encoders.resumeToken.byteLength(frame.resumeToken)
    : 0;
  const metadataMimeTypeLength = frame.metadataMimeType != null
    ? encoders.metadataMimeType.byteLength(frame.metadataMimeType)
    : 0;
  const dataMimeTypeLength = frame.dataMimeType != null
    ? encoders.dataMimeType.byteLength(frame.dataMimeType)
    : 0;
  const payloadLength = getPayloadLength(frame, encoders);
  const buffer = ByteBuffer.allocate(
    FRAME_HEADER_SIZE +
      SETUP_FIXED_SIZE + //
      resumeTokenLength +
      metadataMimeTypeLength +
      dataMimeTypeLength +
      payloadLength,
  );
  let offset = writeHeader(frame, buffer);
  buffer.writeUint16(frame.majorVersion, offset);
  offset += 2;
  buffer.writeUint16(frame.minorVersion, offset);
  offset += 2;
  buffer.writeUint32(frame.keepAlive, offset);
  offset += 4;
  buffer.writeUint32(frame.lifetime, offset);
  offset += 4;
  buffer.writeUint16(resumeTokenLength, offset);
  offset += 2;
  if (frame.resumeToken != null) {
    offset = encoders.resumeToken.encode(
      frame.resumeToken,
      buffer,
      offset,
    );
  }

  buffer.writeUint8(metadataMimeTypeLength, offset);
  offset += 1;
  if (frame.metadataMimeType != null) {
    offset = encoders.metadataMimeType.encode(
      frame.metadataMimeType,
      buffer,
      offset,
    );
  }

  buffer.writeUint8(dataMimeTypeLength, offset);
  offset += 1;
  if (frame.dataMimeType != null) {
    offset = encoders.dataMimeType.encode(
      frame.dataMimeType,
      buffer,
      offset,
    );
  }

  writePayload(frame, buffer, encoders, offset);
  return buffer;
}

/**
 * Reads a SETUP frame from the buffer and returns it.
 */
function deserializeSetupFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): SetupFrame {
  invariant(
    streamId === 0,
    'RSocketBinaryFraming: Invalid SETUP frame, expected stream id to be 0.',
  );

  let offset = FRAME_HEADER_SIZE;
  const majorVersion = buffer.readUint16(offset);
  offset += 2;
  const minorVersion = buffer.readUint16(offset);
  offset += 2;

  const keepAlive = buffer.readInt32(offset);
  offset += 4;
  invariant(
    keepAlive >= 0 && keepAlive <= MAX_KEEPALIVE,
    'RSocketBinaryFraming: Invalid SETUP frame, expected keepAlive to be ' +
      '>= 0 and <= %s. Got `%s`.',
    MAX_KEEPALIVE,
    keepAlive,
  );

  const lifetime = buffer.readInt32(offset);
  offset += 4;
  invariant(
    lifetime >= 0 && lifetime <= MAX_LIFETIME,
    'RSocketBinaryFraming: Invalid SETUP frame, expected lifetime to be ' +
      '>= 0 and <= %s. Got `%s`.',
    MAX_LIFETIME,
    lifetime,
  );

  const resumeTokenLength = buffer.readInt16(offset);
  offset += 2;
  invariant(
    resumeTokenLength >= 0 && resumeTokenLength <= MAX_RESUME_LENGTH,
    'RSocketBinaryFraming: Invalid SETUP frame, expected resumeToken length ' +
      'to be >= 0 and <= %s. Got `%s`.',
    MAX_RESUME_LENGTH,
    resumeTokenLength,
  );
  const resumeToken = encoders.resumeToken.decode(
    buffer,
    offset,
    offset + resumeTokenLength,
  );
  offset += resumeTokenLength;

  const metadataMimeTypeLength = buffer.readUint8(offset);
  offset += 1;
  const metadataMimeType = encoders.metadataMimeType.decode(
    buffer,
    offset,
    offset + metadataMimeTypeLength,
  );
  offset += metadataMimeTypeLength;

  const dataMimeTypeLength = buffer.readUint8(offset);
  offset += 1;
  const dataMimeType = encoders.dataMimeType.decode(
    buffer,
    offset,
    offset + dataMimeTypeLength,
  );
  offset += dataMimeTypeLength;

  const frame: SetupFrame = {
    data: null,
    dataMimeType,
    flags,
    keepAlive,
    lifetime,
    majorVersion,
    metadata: null,
    metadataMimeType,
    minorVersion,
    resumeToken,
    streamId,
    type: FRAME_TYPES.SETUP,
  };
  readPayload(buffer, frame, encoders, offset);
  return frame;
}

/**
 * Writes an ERROR frame into a new buffer and returns it.
 *
 * Prefix size is for the error code (uint32 = 4).
 */
const ERROR_FIXED_SIZE = 4;
function serializeErrorFrame(frame: ErrorFrame, encoders: Encoders<*>): ByteBuffer {
  const messageLength = frame.message != null
    ? encoders.message.byteLength(frame.message)
    : 0;
  const buffer = ByteBuffer.allocate(
    FRAME_HEADER_SIZE + ERROR_FIXED_SIZE + messageLength,
  );
  let offset = writeHeader(frame, buffer);
  buffer.writeUint32(frame.code, offset);
  offset += 4;
  if (frame.message != null) {
    encoders.message.encode(
      frame.message,
      buffer,
      offset,
    );
  }
  return buffer;
}

/**
 * Reads an ERROR frame from the buffer and returns it.
 */
function deserializeErrorFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): ErrorFrame {
  let offset = FRAME_HEADER_SIZE;
  const code = buffer.readInt32(offset);
  offset += 4;
  invariant(
    code >= 0 && code <= MAX_CODE,
    'RSocketBinaryFraming: Invalid ERROR frame, expected code to be >= 0 and <= %s. Got `%s`.',
    MAX_CODE,
    code,
  );
  const messageLength = buffer.limit - offset;
  let message = '';
  if (messageLength > 0) {
    message = encoders.message.decode(buffer, offset, offset + messageLength);
    offset += messageLength;
  }

  return {
    code,
    flags,
    message,
    streamId,
    type: FRAME_TYPES.ERROR,
  };
}

/**
 * Writes a KEEPALIVE frame into a new buffer and returns it.
 *
 * Prefix size is for the last received position (uint64 = 8).
 */
const KEEPALIVE_FIXED_SIZE = 8;
function serializeKeepAliveFrame(
  frame: KeepAliveFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const dataLength = frame.data != null
    ? encoders.data.byteLength(frame.data)
    : 0;
  const buffer = ByteBuffer.allocate(
    FRAME_HEADER_SIZE + KEEPALIVE_FIXED_SIZE + dataLength,
  );
  let offset = writeHeader(frame, buffer);
  buffer.writeUint64(frame.lastReceivedPosition, offset);
  offset += 8;
  if (frame.data != null) {
    encoders.data.encode(frame.data, buffer, offset);
  }
  return buffer;
}

/**
 * Reads a KEEPALIVE frame from the buffer and returns it.
 */
function deserializeKeepAliveFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): KeepAliveFrame {
  invariant(
    streamId === 0,
    'RSocketBinaryFraming: Invalid KEEPALIVE frame, expected stream id to be 0.',
  );

  let offset = FRAME_HEADER_SIZE;
  const lastReceivedPosition = buffer.readUint64(offset).toNumber();
  offset += 8;
  let data = null;
  if (offset < buffer.limit) {
    data = encoders.data.decode(buffer, offset, buffer.limit);
  }

  return {
    data,
    flags,
    lastReceivedPosition,
    streamId,
    type: FRAME_TYPES.KEEPALIVE,
  };
}

/**
 * Writes a LEASE frame into a new buffer and returns it.
 *
 * Prefix size is for the ttl (uint32) and requestcount (uint32).
 */
const LEASE_FIXED_SIZE = 8;
function serializeLeaseFrame(frame: LeaseFrame, encoders: Encoders<*>): ByteBuffer {
  const metaLength = frame.metadata != null
    ? encoders.metadata.byteLength(frame.metadata)
    : 0;
  const buffer = ByteBuffer.allocate(
    FRAME_HEADER_SIZE + LEASE_FIXED_SIZE + metaLength,
  );
  let offset = writeHeader(frame, buffer);
  buffer.writeUint32(frame.ttl, offset);
  offset += 4;
  buffer.writeUint32(frame.requestCount, offset);
  offset += 4;
  if (frame.metadata != null) {
    encoders.metadata.encode(
      frame.metadata,
      buffer,
      offset,
    );
  }
  return buffer;
}

/**
 * Reads a LEASE frame from the buffer and returns it.
 */
function deserializeLeaseFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): LeaseFrame {
  invariant(
    streamId === 0,
    'RSocketBinaryFraming: Invalid LEASE frame, expected stream id to be 0.',
  );

  let offset = FRAME_HEADER_SIZE;
  const ttl = buffer.readUint32(offset);
  offset += 4;
  const requestCount = buffer.readUint32(offset);
  offset += 4;
  let metadata = null;
  if (offset < buffer.limit) {
    metadata = encoders.metadata.decode(buffer, offset, buffer.limit);
  }
  return {
    flags,
    metadata,
    requestCount,
    streamId,
    ttl,
    type: FRAME_TYPES.LEASE,
  };
}

/**
 * Writes a REQUEST_FNF or REQUEST_RESPONSE frame to a new buffer and returns
 * it.
 *
 * Note that these frames have the same shape and only differ in their type.
 */
function serializeRequestFrame(
  frame: RequestFnfFrame | RequestResponseFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const payloadLength = getPayloadLength(frame, encoders);
  const buffer = ByteBuffer.allocate(FRAME_HEADER_SIZE + payloadLength);
  const offset = writeHeader(frame, buffer);
  writePayload(frame, buffer, encoders, offset);
  return buffer;
}

function deserializeRequestFnfFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): RequestFnfFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid REQUEST_FNF frame, expected stream id to be > 0.',
  );
  const frame: RequestFnfFrame = {
    data: null,
    flags,
    metadata: null,
    streamId,
    type: FRAME_TYPES.REQUEST_FNF,
  };
  readPayload(buffer, frame, encoders, FRAME_HEADER_SIZE);
  return frame;
}

function deserializeRequestResponseFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): RequestResponseFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid REQUEST_RESPONSE frame, expected stream id to be > 0.',
  );
  const frame: RequestResponseFrame = {
    data: null,
    flags,
    metadata: null,
    streamId,
    type: FRAME_TYPES.REQUEST_RESPONSE,
  };
  readPayload(buffer, frame, encoders, FRAME_HEADER_SIZE);
  return frame;
}

/**
 * Writes a REQUEST_STREAM or REQUEST_CHANNEL frame to a new buffer and returns
 * it.
 *
 * Note that these frames have the same shape and only differ in their type.
 *
 * Prefix size is for requestN (uint32 = 4).
 */
const REQUEST_MANY_HEADER = 4;
function serializeRequestManyFrame(
  frame: RequestStreamFrame | RequestChannelFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const payloadLength = getPayloadLength(frame, encoders);
  const buffer = ByteBuffer.allocate(
    FRAME_HEADER_SIZE + REQUEST_MANY_HEADER + payloadLength,
  );
  let offset = writeHeader(frame, buffer);
  buffer.writeUint32(frame.requestN, offset);
  offset += 4;
  writePayload(frame, buffer, encoders, offset);
  return buffer;
}

function deserializeRequestStreamFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): RequestStreamFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid REQUEST_STREAM frame, expected stream id to be > 0.',
  );
  let offset = FRAME_HEADER_SIZE;
  const requestN = buffer.readInt32(offset);
  offset += 4;
  invariant(
    requestN > 0,
    'RSocketBinaryFraming: Invalid REQUEST_STREAM frame, expected requestN to be > 0, got `%s`.',
    requestN,
  );
  const frame: RequestStreamFrame = {
    data: null,
    flags,
    metadata: null,
    requestN,
    streamId,
    type: FRAME_TYPES.REQUEST_STREAM,
  };
  readPayload(buffer, frame, encoders, offset);
  return frame;
}

function deserializeRequestChannelFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): RequestChannelFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid REQUEST_CHANNEL frame, expected stream id to be > 0.',
  );
  let offset = FRAME_HEADER_SIZE;
  const requestN = buffer.readInt32(offset);
  offset += 4;
  invariant(
    requestN > 0,
    'RSocketBinaryFraming: Invalid REQUEST_STREAM frame, expected requestN to be > 0, got `%s`.',
    requestN,
  );
  const frame: RequestChannelFrame = {
    data: null,
    flags,
    metadata: null,
    requestN,
    streamId,
    type: FRAME_TYPES.REQUEST_CHANNEL,
  };
  readPayload(buffer, frame, encoders, offset);
  return frame;
}

/**
 * Writes a REQUEST_N frame to a new buffer and returns it.
 *
 * Prefix size is for requestN (uint32 = 4).
 */
const REQUEST_N_HEADER = 4;
function serializeRequestNFrame(
  frame: RequestNFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const buffer = ByteBuffer.allocate(FRAME_HEADER_SIZE + REQUEST_N_HEADER);
  const offset = writeHeader(frame, buffer);
  buffer.writeUint32(frame.requestN, offset);
  return buffer;
}

function deserializeRequestNFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): RequestNFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid REQUEST_N frame, expected stream id to be > 0.',
  );
  const requestN = buffer.readInt32(FRAME_HEADER_SIZE);
  invariant(
    requestN > 0,
    'RSocketBinaryFraming: Invalid REQUEST_STREAM frame, expected requestN to be > 0, got `%s`.',
    requestN,
  );
  return {
    flags,
    requestN,
    streamId,
    type: FRAME_TYPES.REQUEST_N,
  };
}

/**
 * Writes a CANCEL frame to a new buffer and returns it.
 */
function serializeCancelFrame(
  frame: CancelFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const buffer = ByteBuffer.allocate(FRAME_HEADER_SIZE);
  writeHeader(frame, buffer);
  return buffer;
}

function deserializeCancelFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): CancelFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid CANCEL frame, expected stream id to be > 0.',
  );
  return {
    flags,
    streamId,
    type: FRAME_TYPES.CANCEL,
  };
}

/**
 * Writes a PAYLOAD frame to a new buffer and returns it.
 */
function serializePayloadFrame(
  frame: PayloadFrame,
  encoders: Encoders<*>,
): ByteBuffer {
  const payloadLength = getPayloadLength(frame, encoders);
  const buffer = ByteBuffer.allocate(FRAME_HEADER_SIZE + payloadLength);
  const offset = writeHeader(frame, buffer);
  writePayload(frame, buffer, encoders, offset);
  return buffer;
}

function deserializePayloadFrame(
  buffer: ByteBuffer,
  streamId: number,
  flags: number,
  encoders: Encoders<*>,
): PayloadFrame {
  invariant(
    streamId > 0,
    'RSocketBinaryFraming: Invalid PAYLOAD frame, expected stream id to be > 0.',
  );
  const frame: PayloadFrame = {
    data: null,
    flags,
    metadata: null,
    streamId,
    type: FRAME_TYPES.PAYLOAD,
  };
  readPayload(buffer, frame, encoders, FRAME_HEADER_SIZE);
  return frame;
}

/**
 * Write the header of the frame into the buffer.
 */
function writeHeader(frame: Frame, buffer: ByteBuffer): number {
  buffer.writeInt32(frame.streamId, 0);

  // shift frame to high 6 bits, extract lowest 10 bits from flags
  buffer.writeUint16(
    frame.type << FRAME_TYPE_OFFFSET | frame.flags & FLAGS_MASK,
    4,
  );

  return FRAME_HEADER_SIZE;
}

/**
 * Determine the length of the payload section of a frame. Only applies to
 * frame types that MAY have both metadata and data.
 */
function getPayloadLength(
  frame: FrameWithPayload,
  encoders: Encoders<*>,
): number {
  let payloadLength = 0;
  if (frame.data != null) {
    payloadLength += encoders.data.byteLength(frame.data);
  }
  if (isMetadata(frame.flags)) {
    payloadLength += UINT24_SIZE;
    if (frame.metadata != null) {
      payloadLength += encoders.metadata.byteLength(frame.metadata);
    }
  }
  return payloadLength;
}

/**
 * Write the payload of a frame into the given buffer. Only applies to frame
 * types that MAY have both metadata and data.
 */
function writePayload(
  frame: FrameWithPayload,
  buffer: ByteBuffer,
  encoders: Encoders<*>,
  offset: number,
): void {
  if (isMetadata(frame.flags)) {
    if (frame.metadata != null) {
      const metaLength = encoders.metadata.byteLength(frame.metadata);
      writeUint24(buffer, metaLength, offset);
      offset += UINT24_SIZE;
      offset = encoders.metadata.encode(
        frame.metadata,
        buffer,
        offset,
      );
    } else {
      writeUint24(buffer, 0, offset);
      offset += UINT24_SIZE;
    }
  }
  if (frame.data != null) {
    encoders.data.encode(frame.data, buffer, offset);
  }
}

/**
 * Read the payload from a buffer and write it into the frame. Only applies to
 * frame types that MAY have both metadata and data.
 */
function readPayload(
  buffer: ByteBuffer,
  frame: FrameWithPayload,
  encoders: Encoders<*>,
  offset: number,
): void {
  if (isMetadata(frame.flags)) {
    const metaLength = readUint24(buffer, offset);
    offset += UINT24_SIZE;
    if (metaLength > 0) {
      frame.metadata = encoders.metadata.decode(
        buffer,
        offset,
        offset + metaLength,
      );
      offset += metaLength;
    }
  }
  if (offset < buffer.limit) {
    frame.data = encoders.data.decode(buffer, offset, buffer.limit);
  }
}
