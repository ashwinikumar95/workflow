#!/usr/bin/env node
"use strict";

const prompt = `${process.argv.slice(2).join(" ")}`;
if (/username/i.test(prompt)) {
  process.stdout.write("x-access-token");
} else {
  process.stdout.write(process.env.GIT_ASKPASS_TOKEN || "");
}
