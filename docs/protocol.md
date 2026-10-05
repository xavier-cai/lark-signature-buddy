# LSB1 configuration protocol

Lark Signature Buddy uses a compact text token to carry a complete slicing
recipe separately from the original image. The current and only accepted marker
is `LSB1:`.

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
- luminance-to-alpha mapping flag and a 0.0–3.0 gamma value (0.1 steps);
- legacy square output size (retained for V1 wire compatibility) and
  PNG/APNG output type; generated tiles keep their native crop dimensions;
- normalized source-content rectangle (fixed to the whole original image);
- CRC32 over the preceding bytes.

Normalized values use unsigned 16-bit quantization. The final token is URL-safe
Base64 without padding and must not exceed 64 ASCII characters.

## Split input

The browser copies the `LSB1:` configuration string. The user sends that string
and the unmodified original image to the bot, either together or as two messages
in either order. The bot stores the partial request per chat, sender, and thread,
acknowledges every input, and starts processing once both parts are present.

The content rectangle must be `x=0, y=0, width=1, height=1`. The bot validates
the original image dimensions and frame count against the configuration, then
emits PNG tiles for static input or APNG tiles for animated input.

Resource limits are enforced by shared core code:

- 8,192 px maximum image edge;
- 32 MP maximum static image;
- 65,535 animation frames (the protocol field capacity);
- 80 MP total animation decode work;
- 65 output tiles (up to 13 columns × 5 rows);

Any protocol change must update the marker/version, this document, and
round-trip plus rejection tests in the same pull request.
