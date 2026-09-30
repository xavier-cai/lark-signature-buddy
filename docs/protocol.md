# LSB1 transport protocol

Lark Signature Buddy uses a compact QR token to carry a complete slicing recipe
alongside the source pixels. The current and only accepted marker is `LSB1:`.

There is no compatibility fallback. Tokens with the former `IB` marker, unknown
versions, unknown fields, invalid flags, malformed Base64URL, or an invalid
CRC32 are rejected.

## Payload

The binary payload is 41 bytes and records:

- source width, height, animation flag, and frame count;
- grid columns and rows;
- normalized crop rectangle;
- plain or precut mode;
- normalized visual gap ratio;
- luminance-to-alpha mapping flag;
- square output size and PNG/APNG output type;
- normalized source-content rectangle inside the transport canvas;
- CRC32 over the preceding bytes.

Normalized values use unsigned 16-bit quantization. The final token is URL-safe
Base64 without padding and must not exceed 64 ASCII characters.

## Transport image

The browser preserves source resolution, pads narrow images to at least 384
pixels, and adds a QR footer. Static transports are PNG. Animated transports are
GIF so Lark message upload preserves frames. The bot removes padding according
to the content rectangle and emits PNG tiles for static input or APNG tiles for
animated input.

Resource limits are enforced by shared core code:

- 8,192 px maximum edge;
- 32 MP maximum transport canvas;
- 120 animation frames;
- 80 MP total animation decode work;
- 225 output tiles;
- 3,600 frame-tile operations.

Any protocol change must update the marker/version, this document, and
round-trip plus rejection tests in the same pull request.
