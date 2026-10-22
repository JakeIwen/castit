#!/bin/zsh

here=${${(%):-%x}:A:h}
zsh "$here/build.zsh"
open -a "Firefox Developer Edition" "$here/dist/van-tv.xpi"