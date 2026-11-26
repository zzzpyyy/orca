import type { SVGProps } from 'react'

// The desktop bundle retains this notice in the glyph’s SVG metadata.
// https://github.com/ant-design/ant-design-icons (@ant-design/icons-svg 4.4.2, WechatWorkOutlined,
// moved onto a 0-origin grid so the phone draws the same path)
const license = `MIT LICENSE

Copyright (c) 2018-present Ant UED, https://xtech.antfin.com/

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

export function WecomIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 896 896" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <metadata>{license}</metadata>
      <path d="M 845.78 665.59 a 135.87 135.87 0 0 0 -47.04 19.04 a 114.24 114.24 0 0 1 -51.4 31.08 a 76.29 76.29 0 0 1 24.45 -45.42 a 169.3 169.3 0 0 0 23.4 -55.02 a 50.41 50.41 0 1 1 50.6 50.32 z m -92.21 -120.76 a 168.83 168.83 0 0 0 -54.81 -23.68 a 50.41 50.41 0 0 1 -50.4 -50.42 a 50.41 50.41 0 1 1 100.8 0 a 137.5 137.5 0 0 0 18.82 47.2 a 114.8 114.8 0 0 1 30.76 51.66 a 76.08 76.08 0 0 1 -45.02 -24.76 h -0.19 z m -83.04 -177.71 c -15.19 -127.33 -146.98 -227.1 -306.44 -227.1 c -169.87 0 -308.09 113.1 -308.09 252.2 A 235.81 235.81 0 0 0 166.06 583.6 a 311.28 311.28 0 0 0 33.6 21.59 L 186 659.76 c 4.93 2.31 9.7 4.78 14.75 6.9 l 69 -34.5 c 10.07 2.61 20.68 4.3 31.2 6.08 c 6.73 1.2 13.45 2.43 20.35 3.25 a 354.83 354.83 0 0 0 128.81 -7.4 a 248.88 248.88 0 0 0 10.15 55.06 a 425.64 425.64 0 0 1 -96.17 11.24 a 417.98 417.98 0 0 1 -86.4 -9.52 L 152.52 753.4 a 27.62 27.62 0 0 1 -29.98 -3.14 a 28.02 28.02 0 0 1 -9.67 -28.61 l 22.4 -90.24 A 292.26 292.26 0 0 1 0 392.21 C 0 221.98 163 84 364.09 84 c 190.93 0 347.29 124.53 362.52 282.82 a 244.97 244.97 0 0 0 -26.47 -2.62 c -9.9 0.38 -19.79 1.31 -29.6 2.88 z m -116.3 198.81 a 135.76 135.76 0 0 0 47.05 -19.04 a 114.24 114.24 0 0 1 51.45 -31 a 76.47 76.47 0 0 1 -24.5 45.34 a 169.48 169.48 0 0 0 -23.4 55.05 a 50.41 50.41 0 0 1 -100.8 0.23 a 50.41 50.41 0 0 1 50.2 -50.58 m 90.8 121.32 a 168.6 168.6 0 0 0 54.66 23.9 a 50.44 50.44 0 0 1 35.64 86.08 a 50.38 50.38 0 0 1 -86.04 -35.66 a 136.74 136.74 0 0 0 -18.67 -47.28 a 114.71 114.71 0 0 1 -30.54 -51.8 a 76 76 0 0 1 44.95 25.06 z" />
    </svg>
  )
}
