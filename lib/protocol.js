(function (exports, ByteArray) {
    const Protocol = exports;

    const PKG_HEAD_BYTES = 4;
    const MSG_FLAG_BYTES = 1;
    const MSG_ROUTE_CODE_BYTES = 2;
    const MSG_ROUTE_LEN_BYTES = 1;

    const MSG_ROUTE_CODE_MAX = 0xffff;

    const MSG_COMPRESS_ROUTE_MASK = 0x1;
    const MSG_COMPRESS_GZIP_MASK = 0x1;
    const MSG_COMPRESS_GZIP_ENCODE_MASK = 1 << 4;
    const MSG_TYPE_MASK = 0x7;

    const Package = Protocol.Package = {};
    const Message = Protocol.Message = {};

    Package.TYPE_HANDSHAKE = 1;
    Package.TYPE_HANDSHAKE_ACK = 2;
    Package.TYPE_HEARTBEAT = 3;
    Package.TYPE_DATA = 4;
    Package.TYPE_KICK = 5;

    Message.TYPE_REQUEST = 0;
    Message.TYPE_NOTIFY = 1;
    Message.TYPE_RESPONSE = 2;
    Message.TYPE_PUSH = 3;

    function getAllocBuffer(length){
        let buffer;
        if (ByteArray === Buffer) {
            buffer = ByteArray.alloc(length);
        } else {
            buffer = new ByteArray(length);
        }
        return buffer;
    }

    function getFromBuffer(msg){
        let buffer;
        if (ByteArray === Buffer) {
            buffer = ByteArray.from(msg);
        } else {
            buffer = new ByteArray(msg);
        }
        return buffer;
    }

    /**
     * pofresh client encode
     * id message id;
     * route message route
     * msg message body
     * socketio current support string
     */
    Protocol.strencode = function (str) {
        if (typeof Buffer !== "undefined" && ByteArray === Buffer) {
            // encoding defaults to 'utf8'
            return (Buffer.from(str));
        } else {
            let byteArray = new ByteArray(str.length * 3);
            let offset = 0;
            for (let i = 0; i < str.length; i++) {
                let charCode = str.charCodeAt(i);
                let codes = null;
                if (charCode <= 0x7f) {
                    codes = [charCode];
                } else if (charCode <= 0x7ff) {
                    codes = [0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f)];
                } else {
                    codes = [0xe0 | (charCode >> 12), 0x80 | ((charCode & 0xfc0) >> 6), 0x80 | (charCode & 0x3f)];
                }
                for (let j = 0; j < codes.length; j++) {
                    byteArray[offset] = codes[j];
                    ++offset;
                }
            }
            let _buffer = new ByteArray(offset);
            copyArray(_buffer, 0, byteArray, 0, offset);
            return _buffer;
        }
    };

    /**
     * client decode
     * msg String data
     * return Message Object
     */
    Protocol.strdecode = function (buffer) {
        if (typeof Buffer !== "undefined" && ByteArray === Buffer) {
            // encoding defaults to 'utf8'
            return buffer.toString();
        } else {
            let bytes = new ByteArray(buffer);
            let array = [];
            let offset = 0;
            let charCode = 0;
            let end = bytes.length;
            while (offset < end) {
                if (bytes[offset] < 128) {
                    charCode = bytes[offset];
                    offset += 1;
                } else if (bytes[offset] < 224) {
                    charCode = ((bytes[offset] & 0x1f) << 6) + (bytes[offset + 1] & 0x3f);
                    offset += 2;
                } else {
                    charCode = ((bytes[offset] & 0x0f) << 12) + ((bytes[offset + 1] & 0x3f) << 6) + (bytes[offset + 2] & 0x3f);
                    offset += 3;
                }
                array.push(charCode);
            }
            return String.fromCharCode.apply(null, array);
        }
    };

    /**
     * Package protocol encode.
     *
     * Pofresh package format:
     * +------+-------------+------------------+
     * | type | body length |       body       |
     * +------+-------------+------------------+
     *
     * Head: 4bytes
     *   0: package type,
     *      1 - handshake,
     *      2 - handshake ack,
     *      3 - heartbeat,
     *      4 - data
     *      5 - kick
     *   1 - 3: big-endian body length
     * Body: body length bytes
     *
     * @param  {Number}    type   package type
     * @param  {ByteArray} body   body content in bytes
     * @return {ByteArray}        new byte array that contains encode result
     */
    Package.encode = function (type, body) {
        let length = body ? body.length : 0;
        let buffer = getAllocBuffer(PKG_HEAD_BYTES + length);
        let index = 0;
        buffer[index++] = type & 0xff;
        buffer[index++] = (length >> 16) & 0xff;
        buffer[index++] = (length >> 8) & 0xff;
        buffer[index++] = length & 0xff;
        if (body) {
            copyArray(buffer, index, body, 0, length);
        }
        return buffer;
    };

    /**
     * Package protocol decode.
     * See encode for package format.
     *
     * @param  {ByteArray} buffer byte array containing package content
     * @return {Object}           {type: package type, buffer: body byte array}
     */
    Package.decode = function (buffer) {
        let offset = 0;
        let bytes = getFromBuffer(buffer);

        let length = 0;
        let rs = [];
        while (offset < bytes.length) {
            let type = bytes[offset++];
            length = ((bytes[offset++]) << 16 | (bytes[offset++]) << 8 | bytes[offset++]) >>> 0;
            let body = length ? getAllocBuffer(length) : null;
            if (body) {
                copyArray(body, 0, bytes, offset, length);
            }
            offset += length;
            rs.push({'type': type, 'body': body});
        }
        return rs.length === 1 ? rs[0] : rs;
    };

    /**
     * Message protocol encode.
     *
     * @param  {Number} id            message id
     * @param  {Number} type          message type
     * @param  {Number} compressRoute whether compress route
     * @param  {Number|String} route  route code or route string
     * @param  {Buffer} msg           message body bytes
     * @param  {Buffer} compressGzip  compressGzip
     * @return {Buffer}               encode result
     */
    Message.encode = function (id, type, compressRoute, route, msg, compressGzip) {
        // caculate message max length
        let idBytes = msgHasId(type) ? caculateMsgIdBytes(id) : 0;
        let msgLen = MSG_FLAG_BYTES + idBytes;

        if (msgHasRoute(type)) {
            if (compressRoute) {
                if (typeof route !== 'number') {
                    throw new Error('error flag for number route!');
                }
                msgLen += MSG_ROUTE_CODE_BYTES;
            } else {
                msgLen += MSG_ROUTE_LEN_BYTES;
                if (route) {
                    route = Protocol.strencode(route);
                    if (route.length > 255) {
                        throw new Error('route maxlength is overflow');
                    }
                    msgLen += route.length;
                }
            }
        }

        if (msg) {
            msgLen += msg.length;
        }

        let buffer = getAllocBuffer(msgLen);
        let offset = 0;

        // add flag
        offset = encodeMsgFlag(type, compressRoute, buffer, offset, compressGzip);

        // add message id
        if (msgHasId(type)) {
            offset = encodeMsgId(id, buffer, offset);
        }

        // add route
        if (msgHasRoute(type)) {
            offset = encodeMsgRoute(compressRoute, route, buffer, offset);
        }

        // add body
        if (msg) {
            offset = encodeMsgBody(msg, buffer, offset);
        }

        return buffer;
    };

    /**
     * Message protocol decode.
     *
     * @param  {Buffer|Uint8Array} buffer message bytes
     * @return {Object}            message object
     */
    Message.decode = function (buffer) {
        let bytes = getFromBuffer(buffer);
        let bytesLen = bytes.length || bytes.byteLength;
        let offset = 0;
        let id = 0;
        let route = null;

        // parse flag
        let flag = bytes[offset++];
        let compressRoute = flag & MSG_COMPRESS_ROUTE_MASK;
        let type = (flag >> 1) & MSG_TYPE_MASK;
        let compressGzip = (flag >> 4) & MSG_COMPRESS_GZIP_MASK;

        // parse id
        if (msgHasId(type)) {
            let m = 0;
            let i = 0;
            do {
                m = parseInt(bytes[offset]);
                id += (m & 0x7f) << (7 * i);
                offset++;
                i++;
            } while (m >= 128);
        }

        // parse route
        if (msgHasRoute(type)) {
            if (compressRoute) {
                route = (bytes[offset++]) << 8 | bytes[offset++];
            } else {
                let routeLen = bytes[offset++];
                if (routeLen) {
                    route = getAllocBuffer(routeLen);
                    copyArray(route, 0, bytes, offset, routeLen);
                    route = Protocol.strdecode(route);
                } else {
                    route = '';
                }
                offset += routeLen;
            }
        }

        // parse body
        let bodyLen = bytesLen - offset;
        let body = getAllocBuffer(bodyLen);

        copyArray(body, 0, bytes, offset, bodyLen);

        return {
            'id': id, 'type': type, 'compressRoute': compressRoute,
            'route': route, 'body': body, 'compressGzip': compressGzip
        };
    };

    function copyArray(dest, doffset, src, soffset, length) {
        if ('function' === typeof src.copy) {
            // Buffer
            src.copy(dest, doffset, soffset, soffset + length);
        } else {
            // Uint8Array
            for (let index = 0; index < length; index++) {
                dest[doffset++] = src[soffset++];
            }
        }
    }

    function msgHasId(type) {
        return type === Message.TYPE_REQUEST || type === Message.TYPE_RESPONSE;
    }

    function msgHasRoute(type) {
        return type === Message.TYPE_REQUEST || type === Message.TYPE_NOTIFY ||
            type === Message.TYPE_PUSH;
    }

    function caculateMsgIdBytes(id) {
        let len = 0;
        do {
            len += 1;
            id >>= 7;
        } while (id > 0);
        return len;
    }

    function encodeMsgFlag(type, compressRoute, buffer, offset, compressGzip) {
        if (type !== Message.TYPE_REQUEST && type !== Message.TYPE_NOTIFY &&
            type !== Message.TYPE_RESPONSE && type !== Message.TYPE_PUSH) {
            throw new Error('unkonw message type: ' + type);
        }

        buffer[offset] = (type << 1) | (compressRoute ? 1 : 0);

        if (compressGzip) {
            buffer[offset] = buffer[offset] | MSG_COMPRESS_GZIP_ENCODE_MASK;
        }

        return offset + MSG_FLAG_BYTES;
    }

    function encodeMsgId(id, buffer, offset) {
        do {
            let tmp = id % 128;
            let next = Math.floor(id / 128);

            if (next !== 0) {
                tmp = tmp + 128;
            }
            buffer[offset++] = tmp;

            id = next;
        } while (id !== 0);

        return offset;
    }

    function encodeMsgRoute(compressRoute, route, buffer, offset) {
        if (compressRoute) {
            if (route > MSG_ROUTE_CODE_MAX) {
                throw new Error('route number is overflow');
            }

            buffer[offset++] = (route >> 8) & 0xff;
            buffer[offset++] = route & 0xff;
        } else {
            if (route) {
                buffer[offset++] = route.length & 0xff;
                copyArray(buffer, offset, route, 0, route.length);
                offset += route.length;
            } else {
                buffer[offset++] = 0;
            }
        }

        return offset;
    }

    function encodeMsgBody(msg, buffer, offset) {
        copyArray(buffer, offset, msg, 0, msg.length);
        return offset + msg.length;
    }

    module.exports = Protocol;
    if (typeof (window) !== "undefined") {
        window.Protocol = Protocol;
    }
})(typeof (window) === "undefined" ? module.exports : (this.Protocol = {}), typeof (window) === "undefined" ? Buffer : Uint8Array, this);
