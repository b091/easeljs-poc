System.config({
  "baseURL": ".",
  "defaultJSExtensions": true,
  "transpiler": "babel",
  "babelOptions": {
    "optional": [
      "runtime"
    ]
  },
  "paths": {
    "github:*": "jspm_packages/github/*",
    "npm:*": "jspm_packages/npm/*"
  }
});

System.config({
  "map": {
    "EaselJS": "github:CreateJS/EaselJS@0.8.1",
    "TweenJS": "github:CreateJS/TweenJS@0.6.1",
    "babel": "npm:babel-core@5.6.17",
    "babel-runtime": "npm:babel-runtime@5.6.17",
    "core-js": "npm:core-js@0.9.18",
    "hammer": "github:hammerjs/hammer.js@2.0.4",
    "github:jspm/nodelibs-process@0.1.1": {
      "process": "npm:process@0.10.1"
    },
    "npm:babel-runtime@5.6.17": {
      "process": "github:jspm/nodelibs-process@0.1.1"
    },
    "npm:core-js@0.9.18": {
      "fs": "github:jspm/nodelibs-fs@0.1.2",
      "process": "github:jspm/nodelibs-process@0.1.1",
      "systemjs-json": "github:systemjs/plugin-json@0.1.0"
    }
  }
});

