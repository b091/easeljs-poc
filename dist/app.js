(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      var hasOwnProperty = exports && exports.hasOwnProperty;
      entry.esModule = {};
      for (var p in exports) {
        if (!hasOwnProperty || exports.hasOwnProperty(p))
          entry.esModule[p] = exports[p];
      }
      entry.esModule['default'] = exports;
      entry.esModule.__useDefault = true;
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, declare) {
    return function(formatDetect) {
      formatDetect(function() {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          },
          'import': function() {
            throw new TypeError('Dynamic System.import calls are not supported for SFX bundles. Rather use a named bundle.');
          }
        };
        System.set('@empty', {});

        declare(System);

        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], function(System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(factory);
  // etc UMD / module pattern
})*/

(['src/App.js'], function(System) {

(function(__global) {
  var loader = System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  };

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = loader.baseURL + (module.id[0] == '/' ? module.id : '/' + module.id);

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        // set global require to AMD require
        var curRequire = __global.require;
        __global.require = require;

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        __global.require = curRequire;

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if it has no dependencies and we don't have any other
      // defines, then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (deps.length == 0 && !lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);
(function(__global) {
  var hasOwnProperty = __global.hasOwnProperty;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function readMemberExpression(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  // bare minimum ignores for IE8
  var ignoredGlobalProps = ['_g', 'sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external'];

  var globalSnapshot;

  function forEachGlobal(callback) {
    if (Object.keys)
      Object.keys(__global).forEach(callback);
    else
      for (var g in __global) {
        if (!hasOwnProperty.call(__global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobalValue(callback) {
    forEachGlobal(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = __global[globalName];
      }
      catch (e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  System.set('@@global-helpers', System.newModule({
    prepareGlobal: function(moduleName, exportName, globals) {
      // set globals
      var oldGlobals;
      if (globals) {
        oldGlobals = {};
        for (var g in globals) {
          oldGlobals[g] = globals[g];
          __global[g] = globals[g];
        }
      }

      // store a complete copy of the global object in order to detect changes
      if (!exportName) {
        globalSnapshot = {};

        forEachGlobalValue(function(name, value) {
          globalSnapshot[name] = value;
        });
      }

      // return function to retrieve global
      return function() {
        var globalValue;

        if (exportName) {
          globalValue = readMemberExpression(exportName, __global);
        }
        else {
          var singleGlobal;
          var multipleExports;
          var exports = {};

          forEachGlobalValue(function(name, value) {
            if (globalSnapshot[name] === value)
              return;
            if (typeof value == 'undefined')
              return;
            exports[name] = value;

            if (typeof singleGlobal != 'undefined') {
              if (!multipleExports && singleGlobal !== value)
                multipleExports = true;
            }
            else {
              singleGlobal = value;
            }
          });
          globalValue = multipleExports ? exports : singleGlobal;
        }

        // revert globals
        if (oldGlobals) {
          for (var g in oldGlobals)
            __global[g] = oldGlobals[g];
        }

        return globalValue;
      };
    }
  }));

})(typeof self != 'undefined' ? self : global);

System.registerDynamic("npm:core-js@0.9.18/library/modules/$.fw.js", [], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.registerDynamic("npm:babel-runtime@5.6.17/helpers/class-call-check.js", [], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.registerDynamic("github:CreateJS/EaselJS@0.8.1/lib/easeljs-0.8.1.combined.js", [], false, function(__require, __exports, __module) {
  var _retrieveGlobal = System.get("@@global-helpers").prepareGlobal(__module.id, null, null);
  (function() {
    this.createjs = this.createjs || {};
    createjs.extend = function(subclass, superclass) {
      "use strict";
      function o() {
        this.constructor = subclass;
      }
      o.prototype = superclass.prototype;
      return (subclass.prototype = new o());
    };
    this.createjs = this.createjs || {};
    createjs.promote = function(subclass, prefix) {
      "use strict";
      var subP = subclass.prototype,
          supP = (Object.getPrototypeOf && Object.getPrototypeOf(subP)) || subP.__proto__;
      if (supP) {
        subP[(prefix += "_") + "constructor"] = supP.constructor;
        for (var n in supP) {
          if (subP.hasOwnProperty(n) && (typeof supP[n] == "function")) {
            subP[prefix + n] = supP[n];
          }
        }
      }
      return subclass;
    };
    this.createjs = this.createjs || {};
    createjs.indexOf = function(array, searchElement) {
      "use strict";
      for (var i = 0,
          l = array.length; i < l; i++) {
        if (searchElement === array[i]) {
          return i;
        }
      }
      return -1;
    };
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Event(type, bubbles, cancelable) {
        this.type = type;
        this.target = null;
        this.currentTarget = null;
        this.eventPhase = 0;
        this.bubbles = !!bubbles;
        this.cancelable = !!cancelable;
        this.timeStamp = (new Date()).getTime();
        this.defaultPrevented = false;
        this.propagationStopped = false;
        this.immediatePropagationStopped = false;
        this.removed = false;
      }
      var p = Event.prototype;
      p.preventDefault = function() {
        this.defaultPrevented = this.cancelable && true;
      };
      p.stopPropagation = function() {
        this.propagationStopped = true;
      };
      p.stopImmediatePropagation = function() {
        this.immediatePropagationStopped = this.propagationStopped = true;
      };
      p.remove = function() {
        this.removed = true;
      };
      p.clone = function() {
        return new Event(this.type, this.bubbles, this.cancelable);
      };
      p.set = function(props) {
        for (var n in props) {
          this[n] = props[n];
        }
        return this;
      };
      p.toString = function() {
        return "[Event (type=" + this.type + ")]";
      };
      createjs.Event = Event;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function EventDispatcher() {
        this._listeners = null;
        this._captureListeners = null;
      }
      var p = EventDispatcher.prototype;
      EventDispatcher.initialize = function(target) {
        target.addEventListener = p.addEventListener;
        target.on = p.on;
        target.removeEventListener = target.off = p.removeEventListener;
        target.removeAllEventListeners = p.removeAllEventListeners;
        target.hasEventListener = p.hasEventListener;
        target.dispatchEvent = p.dispatchEvent;
        target._dispatchEvent = p._dispatchEvent;
        target.willTrigger = p.willTrigger;
      };
      p.addEventListener = function(type, listener, useCapture) {
        var listeners;
        if (useCapture) {
          listeners = this._captureListeners = this._captureListeners || {};
        } else {
          listeners = this._listeners = this._listeners || {};
        }
        var arr = listeners[type];
        if (arr) {
          this.removeEventListener(type, listener, useCapture);
        }
        arr = listeners[type];
        if (!arr) {
          listeners[type] = [listener];
        } else {
          arr.push(listener);
        }
        return listener;
      };
      p.on = function(type, listener, scope, once, data, useCapture) {
        if (listener.handleEvent) {
          scope = scope || listener;
          listener = listener.handleEvent;
        }
        scope = scope || this;
        return this.addEventListener(type, function(evt) {
          listener.call(scope, evt, data);
          once && evt.remove();
        }, useCapture);
      };
      p.removeEventListener = function(type, listener, useCapture) {
        var listeners = useCapture ? this._captureListeners : this._listeners;
        if (!listeners) {
          return;
        }
        var arr = listeners[type];
        if (!arr) {
          return;
        }
        for (var i = 0,
            l = arr.length; i < l; i++) {
          if (arr[i] == listener) {
            if (l == 1) {
              delete(listeners[type]);
            } else {
              arr.splice(i, 1);
            }
            break;
          }
        }
      };
      p.off = p.removeEventListener;
      p.removeAllEventListeners = function(type) {
        if (!type) {
          this._listeners = this._captureListeners = null;
        } else {
          if (this._listeners) {
            delete(this._listeners[type]);
          }
          if (this._captureListeners) {
            delete(this._captureListeners[type]);
          }
        }
      };
      p.dispatchEvent = function(eventObj, bubbles, cancelable) {
        if (typeof eventObj == "string") {
          var listeners = this._listeners;
          if (!bubbles && (!listeners || !listeners[eventObj])) {
            return true;
          }
          eventObj = new createjs.Event(eventObj, bubbles, cancelable);
        } else if (eventObj.target && eventObj.clone) {
          eventObj = eventObj.clone();
        }
        try {
          eventObj.target = this;
        } catch (e) {}
        if (!eventObj.bubbles || !this.parent) {
          this._dispatchEvent(eventObj, 2);
        } else {
          var top = this,
              list = [top];
          while (top.parent) {
            list.push(top = top.parent);
          }
          var i,
              l = list.length;
          for (i = l - 1; i >= 0 && !eventObj.propagationStopped; i--) {
            list[i]._dispatchEvent(eventObj, 1 + (i == 0));
          }
          for (i = 1; i < l && !eventObj.propagationStopped; i++) {
            list[i]._dispatchEvent(eventObj, 3);
          }
        }
        return !eventObj.defaultPrevented;
      };
      p.hasEventListener = function(type) {
        var listeners = this._listeners,
            captureListeners = this._captureListeners;
        return !!((listeners && listeners[type]) || (captureListeners && captureListeners[type]));
      };
      p.willTrigger = function(type) {
        var o = this;
        while (o) {
          if (o.hasEventListener(type)) {
            return true;
          }
          o = o.parent;
        }
        return false;
      };
      p.toString = function() {
        return "[EventDispatcher]";
      };
      p._dispatchEvent = function(eventObj, eventPhase) {
        var l,
            listeners = (eventPhase == 1) ? this._captureListeners : this._listeners;
        if (eventObj && listeners) {
          var arr = listeners[eventObj.type];
          if (!arr || !(l = arr.length)) {
            return;
          }
          try {
            eventObj.currentTarget = this;
          } catch (e) {}
          try {
            eventObj.eventPhase = eventPhase;
          } catch (e) {}
          eventObj.removed = false;
          arr = arr.slice();
          for (var i = 0; i < l && !eventObj.immediatePropagationStopped; i++) {
            var o = arr[i];
            if (o.handleEvent) {
              o.handleEvent(eventObj);
            } else {
              o(eventObj);
            }
            if (eventObj.removed) {
              this.off(eventObj.type, o, eventPhase == 1);
              eventObj.removed = false;
            }
          }
        }
      };
      createjs.EventDispatcher = EventDispatcher;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Ticker() {
        throw "Ticker cannot be instantiated.";
      }
      Ticker.RAF_SYNCHED = "synched";
      Ticker.RAF = "raf";
      Ticker.TIMEOUT = "timeout";
      Ticker.useRAF = false;
      Ticker.timingMode = null;
      Ticker.maxDelta = 0;
      Ticker.paused = false;
      Ticker.removeEventListener = null;
      Ticker.removeAllEventListeners = null;
      Ticker.dispatchEvent = null;
      Ticker.hasEventListener = null;
      Ticker._listeners = null;
      createjs.EventDispatcher.initialize(Ticker);
      Ticker._addEventListener = Ticker.addEventListener;
      Ticker.addEventListener = function() {
        !Ticker._inited && Ticker.init();
        return Ticker._addEventListener.apply(Ticker, arguments);
      };
      Ticker._inited = false;
      Ticker._startTime = 0;
      Ticker._pausedTime = 0;
      Ticker._ticks = 0;
      Ticker._pausedTicks = 0;
      Ticker._interval = 50;
      Ticker._lastTime = 0;
      Ticker._times = null;
      Ticker._tickTimes = null;
      Ticker._timerId = null;
      Ticker._raf = true;
      Ticker.setInterval = function(interval) {
        Ticker._interval = interval;
        if (!Ticker._inited) {
          return;
        }
        Ticker._setupTick();
      };
      Ticker.getInterval = function() {
        return Ticker._interval;
      };
      Ticker.setFPS = function(value) {
        Ticker.setInterval(1000 / value);
      };
      Ticker.getFPS = function() {
        return 1000 / Ticker._interval;
      };
      try {
        Object.defineProperties(Ticker, {
          interval: {
            get: Ticker.getInterval,
            set: Ticker.setInterval
          },
          framerate: {
            get: Ticker.getFPS,
            set: Ticker.setFPS
          }
        });
      } catch (e) {
        console.log(e);
      }
      Ticker.init = function() {
        if (Ticker._inited) {
          return;
        }
        Ticker._inited = true;
        Ticker._times = [];
        Ticker._tickTimes = [];
        Ticker._startTime = Ticker._getTime();
        Ticker._times.push(Ticker._lastTime = 0);
        Ticker.interval = Ticker._interval;
      };
      Ticker.reset = function() {
        if (Ticker._raf) {
          var f = window.cancelAnimationFrame || window.webkitCancelAnimationFrame || window.mozCancelAnimationFrame || window.oCancelAnimationFrame || window.msCancelAnimationFrame;
          f && f(Ticker._timerId);
        } else {
          clearTimeout(Ticker._timerId);
        }
        Ticker.removeAllEventListeners("tick");
        Ticker._timerId = Ticker._times = Ticker._tickTimes = null;
        Ticker._startTime = Ticker._lastTime = Ticker._ticks = 0;
        Ticker._inited = false;
      };
      Ticker.getMeasuredTickTime = function(ticks) {
        var ttl = 0,
            times = Ticker._tickTimes;
        if (!times || times.length < 1) {
          return -1;
        }
        ticks = Math.min(times.length, ticks || (Ticker.getFPS() | 0));
        for (var i = 0; i < ticks; i++) {
          ttl += times[i];
        }
        return ttl / ticks;
      };
      Ticker.getMeasuredFPS = function(ticks) {
        var times = Ticker._times;
        if (!times || times.length < 2) {
          return -1;
        }
        ticks = Math.min(times.length - 1, ticks || (Ticker.getFPS() | 0));
        return 1000 / ((times[0] - times[ticks]) / ticks);
      };
      Ticker.setPaused = function(value) {
        Ticker.paused = value;
      };
      Ticker.getPaused = function() {
        return Ticker.paused;
      };
      Ticker.getTime = function(runTime) {
        return Ticker._startTime ? Ticker._getTime() - (runTime ? Ticker._pausedTime : 0) : -1;
      };
      Ticker.getEventTime = function(runTime) {
        return Ticker._startTime ? (Ticker._lastTime || Ticker._startTime) - (runTime ? Ticker._pausedTime : 0) : -1;
      };
      Ticker.getTicks = function(pauseable) {
        return Ticker._ticks - (pauseable ? Ticker._pausedTicks : 0);
      };
      Ticker._handleSynch = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        if (Ticker._getTime() - Ticker._lastTime >= (Ticker._interval - 1) * 0.97) {
          Ticker._tick();
        }
      };
      Ticker._handleRAF = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        Ticker._tick();
      };
      Ticker._handleTimeout = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        Ticker._tick();
      };
      Ticker._setupTick = function() {
        if (Ticker._timerId != null) {
          return;
        }
        var mode = Ticker.timingMode || (Ticker.useRAF && Ticker.RAF_SYNCHED);
        if (mode == Ticker.RAF_SYNCHED || mode == Ticker.RAF) {
          var f = window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.oRequestAnimationFrame || window.msRequestAnimationFrame;
          if (f) {
            Ticker._timerId = f(mode == Ticker.RAF ? Ticker._handleRAF : Ticker._handleSynch);
            Ticker._raf = true;
            return;
          }
        }
        Ticker._raf = false;
        Ticker._timerId = setTimeout(Ticker._handleTimeout, Ticker._interval);
      };
      Ticker._tick = function() {
        var paused = Ticker.paused;
        var time = Ticker._getTime();
        var elapsedTime = time - Ticker._lastTime;
        Ticker._lastTime = time;
        Ticker._ticks++;
        if (paused) {
          Ticker._pausedTicks++;
          Ticker._pausedTime += elapsedTime;
        }
        if (Ticker.hasEventListener("tick")) {
          var event = new createjs.Event("tick");
          var maxDelta = Ticker.maxDelta;
          event.delta = (maxDelta && elapsedTime > maxDelta) ? maxDelta : elapsedTime;
          event.paused = paused;
          event.time = time;
          event.runTime = time - Ticker._pausedTime;
          Ticker.dispatchEvent(event);
        }
        Ticker._tickTimes.unshift(Ticker._getTime() - time);
        while (Ticker._tickTimes.length > 100) {
          Ticker._tickTimes.pop();
        }
        Ticker._times.unshift(time);
        while (Ticker._times.length > 100) {
          Ticker._times.pop();
        }
      };
      var now = window.performance && (performance.now || performance.mozNow || performance.msNow || performance.oNow || performance.webkitNow);
      Ticker._getTime = function() {
        return ((now && now.call(performance)) || (new Date().getTime())) - Ticker._startTime;
      };
      createjs.Ticker = Ticker;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function UID() {
        throw "UID cannot be instantiated";
      }
      UID._nextID = 0;
      UID.get = function() {
        return UID._nextID++;
      };
      createjs.UID = UID;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function MouseEvent(type, bubbles, cancelable, stageX, stageY, nativeEvent, pointerID, primary, rawX, rawY, relatedTarget) {
        this.Event_constructor(type, bubbles, cancelable);
        this.stageX = stageX;
        this.stageY = stageY;
        this.rawX = (rawX == null) ? stageX : rawX;
        this.rawY = (rawY == null) ? stageY : rawY;
        this.nativeEvent = nativeEvent;
        this.pointerID = pointerID;
        this.primary = !!primary;
        this.relatedTarget = relatedTarget;
      }
      var p = createjs.extend(MouseEvent, createjs.Event);
      p._get_localX = function() {
        return this.currentTarget.globalToLocal(this.rawX, this.rawY).x;
      };
      p._get_localY = function() {
        return this.currentTarget.globalToLocal(this.rawX, this.rawY).y;
      };
      p._get_isTouch = function() {
        return this.pointerID !== -1;
      };
      try {
        Object.defineProperties(p, {
          localX: {get: p._get_localX},
          localY: {get: p._get_localY},
          isTouch: {get: p._get_isTouch}
        });
      } catch (e) {}
      p.clone = function() {
        return new MouseEvent(this.type, this.bubbles, this.cancelable, this.stageX, this.stageY, this.nativeEvent, this.pointerID, this.primary, this.rawX, this.rawY);
      };
      p.toString = function() {
        return "[MouseEvent (type=" + this.type + " stageX=" + this.stageX + " stageY=" + this.stageY + ")]";
      };
      createjs.MouseEvent = createjs.promote(MouseEvent, "Event");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Matrix2D(a, b, c, d, tx, ty) {
        this.setValues(a, b, c, d, tx, ty);
      }
      var p = Matrix2D.prototype;
      Matrix2D.DEG_TO_RAD = Math.PI / 180;
      Matrix2D.identity = null;
      p.setValues = function(a, b, c, d, tx, ty) {
        this.a = (a == null) ? 1 : a;
        this.b = b || 0;
        this.c = c || 0;
        this.d = (d == null) ? 1 : d;
        this.tx = tx || 0;
        this.ty = ty || 0;
        return this;
      };
      p.append = function(a, b, c, d, tx, ty) {
        var a1 = this.a;
        var b1 = this.b;
        var c1 = this.c;
        var d1 = this.d;
        if (a != 1 || b != 0 || c != 0 || d != 1) {
          this.a = a1 * a + c1 * b;
          this.b = b1 * a + d1 * b;
          this.c = a1 * c + c1 * d;
          this.d = b1 * c + d1 * d;
        }
        this.tx = a1 * tx + c1 * ty + this.tx;
        this.ty = b1 * tx + d1 * ty + this.ty;
        return this;
      };
      p.prepend = function(a, b, c, d, tx, ty) {
        var a1 = this.a;
        var c1 = this.c;
        var tx1 = this.tx;
        this.a = a * a1 + c * this.b;
        this.b = b * a1 + d * this.b;
        this.c = a * c1 + c * this.d;
        this.d = b * c1 + d * this.d;
        this.tx = a * tx1 + c * this.ty + tx;
        this.ty = b * tx1 + d * this.ty + ty;
        return this;
      };
      p.appendMatrix = function(matrix) {
        return this.append(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
      };
      p.prependMatrix = function(matrix) {
        return this.prepend(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
      };
      p.appendTransform = function(x, y, scaleX, scaleY, rotation, skewX, skewY, regX, regY) {
        if (rotation % 360) {
          var r = rotation * Matrix2D.DEG_TO_RAD;
          var cos = Math.cos(r);
          var sin = Math.sin(r);
        } else {
          cos = 1;
          sin = 0;
        }
        if (skewX || skewY) {
          skewX *= Matrix2D.DEG_TO_RAD;
          skewY *= Matrix2D.DEG_TO_RAD;
          this.append(Math.cos(skewY), Math.sin(skewY), -Math.sin(skewX), Math.cos(skewX), x, y);
          this.append(cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, 0, 0);
        } else {
          this.append(cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, x, y);
        }
        if (regX || regY) {
          this.tx -= regX * this.a + regY * this.c;
          this.ty -= regX * this.b + regY * this.d;
        }
        return this;
      };
      p.prependTransform = function(x, y, scaleX, scaleY, rotation, skewX, skewY, regX, regY) {
        if (rotation % 360) {
          var r = rotation * Matrix2D.DEG_TO_RAD;
          var cos = Math.cos(r);
          var sin = Math.sin(r);
        } else {
          cos = 1;
          sin = 0;
        }
        if (regX || regY) {
          this.tx -= regX;
          this.ty -= regY;
        }
        if (skewX || skewY) {
          skewX *= Matrix2D.DEG_TO_RAD;
          skewY *= Matrix2D.DEG_TO_RAD;
          this.prepend(cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, 0, 0);
          this.prepend(Math.cos(skewY), Math.sin(skewY), -Math.sin(skewX), Math.cos(skewX), x, y);
        } else {
          this.prepend(cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, x, y);
        }
        return this;
      };
      p.rotate = function(angle) {
        angle = angle * Matrix2D.DEG_TO_RAD;
        var cos = Math.cos(angle);
        var sin = Math.sin(angle);
        var a1 = this.a;
        var b1 = this.b;
        this.a = a1 * cos + this.c * sin;
        this.b = b1 * cos + this.d * sin;
        this.c = -a1 * sin + this.c * cos;
        this.d = -b1 * sin + this.d * cos;
        return this;
      };
      p.skew = function(skewX, skewY) {
        skewX = skewX * Matrix2D.DEG_TO_RAD;
        skewY = skewY * Matrix2D.DEG_TO_RAD;
        this.append(Math.cos(skewY), Math.sin(skewY), -Math.sin(skewX), Math.cos(skewX), 0, 0);
        return this;
      };
      p.scale = function(x, y) {
        this.a *= x;
        this.b *= x;
        this.c *= y;
        this.d *= y;
        return this;
      };
      p.translate = function(x, y) {
        this.tx += this.a * x + this.c * y;
        this.ty += this.b * x + this.d * y;
        return this;
      };
      p.identity = function() {
        this.a = this.d = 1;
        this.b = this.c = this.tx = this.ty = 0;
        return this;
      };
      p.invert = function() {
        var a1 = this.a;
        var b1 = this.b;
        var c1 = this.c;
        var d1 = this.d;
        var tx1 = this.tx;
        var n = a1 * d1 - b1 * c1;
        this.a = d1 / n;
        this.b = -b1 / n;
        this.c = -c1 / n;
        this.d = a1 / n;
        this.tx = (c1 * this.ty - d1 * tx1) / n;
        this.ty = -(a1 * this.ty - b1 * tx1) / n;
        return this;
      };
      p.isIdentity = function() {
        return this.tx === 0 && this.ty === 0 && this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1;
      };
      p.equals = function(matrix) {
        return this.tx === matrix.tx && this.ty === matrix.ty && this.a === matrix.a && this.b === matrix.b && this.c === matrix.c && this.d === matrix.d;
      };
      p.transformPoint = function(x, y, pt) {
        pt = pt || {};
        pt.x = x * this.a + y * this.c + this.tx;
        pt.y = x * this.b + y * this.d + this.ty;
        return pt;
      };
      p.decompose = function(target) {
        if (target == null) {
          target = {};
        }
        target.x = this.tx;
        target.y = this.ty;
        target.scaleX = Math.sqrt(this.a * this.a + this.b * this.b);
        target.scaleY = Math.sqrt(this.c * this.c + this.d * this.d);
        var skewX = Math.atan2(-this.c, this.d);
        var skewY = Math.atan2(this.b, this.a);
        var delta = Math.abs(1 - skewX / skewY);
        if (delta < 0.00001) {
          target.rotation = skewY / Matrix2D.DEG_TO_RAD;
          if (this.a < 0 && this.d >= 0) {
            target.rotation += (target.rotation <= 0) ? 180 : -180;
          }
          target.skewX = target.skewY = 0;
        } else {
          target.skewX = skewX / Matrix2D.DEG_TO_RAD;
          target.skewY = skewY / Matrix2D.DEG_TO_RAD;
        }
        return target;
      };
      p.copy = function(matrix) {
        return this.setValues(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
      };
      p.clone = function() {
        return new Matrix2D(this.a, this.b, this.c, this.d, this.tx, this.ty);
      };
      p.toString = function() {
        return "[Matrix2D (a=" + this.a + " b=" + this.b + " c=" + this.c + " d=" + this.d + " tx=" + this.tx + " ty=" + this.ty + ")]";
      };
      Matrix2D.identity = new Matrix2D();
      createjs.Matrix2D = Matrix2D;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function DisplayProps(visible, alpha, shadow, compositeOperation, matrix) {
        this.setValues(visible, alpha, shadow, compositeOperation, matrix);
      }
      var p = DisplayProps.prototype;
      p.setValues = function(visible, alpha, shadow, compositeOperation, matrix) {
        this.visible = visible == null ? true : !!visible;
        this.alpha = alpha == null ? 1 : alpha;
        this.shadow = shadow;
        this.compositeOperation = shadow;
        this.matrix = matrix || (this.matrix && this.matrix.identity()) || new createjs.Matrix2D();
        return this;
      };
      p.append = function(visible, alpha, shadow, compositeOperation, matrix) {
        this.alpha *= alpha;
        this.shadow = shadow || this.shadow;
        this.compositeOperation = compositeOperation || this.compositeOperation;
        this.visible = this.visible && visible;
        matrix && this.matrix.appendMatrix(matrix);
        return this;
      };
      p.prepend = function(visible, alpha, shadow, compositeOperation, matrix) {
        this.alpha *= alpha;
        this.shadow = this.shadow || shadow;
        this.compositeOperation = this.compositeOperation || compositeOperation;
        this.visible = this.visible && visible;
        matrix && this.matrix.prependMatrix(matrix);
        return this;
      };
      p.identity = function() {
        this.visible = true;
        this.alpha = 1;
        this.shadow = this.compositeOperation = null;
        this.matrix.identity();
        return this;
      };
      p.clone = function() {
        return new DisplayProps(this.alpha, this.shadow, this.compositeOperation, this.visible, this.matrix.clone());
      };
      createjs.DisplayProps = DisplayProps;
    })();
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Point(x, y) {
        this.setValues(x, y);
      }
      var p = Point.prototype;
      p.setValues = function(x, y) {
        this.x = x || 0;
        this.y = y || 0;
        return this;
      };
      p.copy = function(point) {
        this.x = point.x;
        this.y = point.y;
        return this;
      };
      p.clone = function() {
        return new Point(this.x, this.y);
      };
      p.toString = function() {
        return "[Point (x=" + this.x + " y=" + this.y + ")]";
      };
      createjs.Point = Point;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Rectangle(x, y, width, height) {
        this.setValues(x, y, width, height);
      }
      var p = Rectangle.prototype;
      p.setValues = function(x, y, width, height) {
        this.x = x || 0;
        this.y = y || 0;
        this.width = width || 0;
        this.height = height || 0;
        return this;
      };
      p.extend = function(x, y, width, height) {
        width = width || 0;
        height = height || 0;
        if (x + width > this.x + this.width) {
          this.width = x + width - this.x;
        }
        if (y + height > this.y + this.height) {
          this.height = y + height - this.y;
        }
        if (x < this.x) {
          this.width += this.x - x;
          this.x = x;
        }
        if (y < this.y) {
          this.height += this.y - y;
          this.y = y;
        }
        return this;
      };
      p.pad = function(top, left, bottom, right) {
        this.x -= left;
        this.y -= top;
        this.width += left + right;
        this.height += top + bottom;
        return this;
      };
      p.copy = function(rectangle) {
        return this.setValues(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      };
      p.contains = function(x, y, width, height) {
        width = width || 0;
        height = height || 0;
        return (x >= this.x && x + width <= this.x + this.width && y >= this.y && y + height <= this.y + this.height);
      };
      p.union = function(rect) {
        return this.clone().extend(rect.x, rect.y, rect.width, rect.height);
      };
      p.intersection = function(rect) {
        var x1 = rect.x,
            y1 = rect.y,
            x2 = x1 + rect.width,
            y2 = y1 + rect.height;
        if (this.x > x1) {
          x1 = this.x;
        }
        if (this.y > y1) {
          y1 = this.y;
        }
        if (this.x + this.width < x2) {
          x2 = this.x + this.width;
        }
        if (this.y + this.height < y2) {
          y2 = this.y + this.height;
        }
        return (x2 <= x1 || y2 <= y1) ? null : new Rectangle(x1, y1, x2 - x1, y2 - y1);
      };
      p.intersects = function(rect) {
        return (rect.x <= this.x + this.width && this.x <= rect.x + rect.width && rect.y <= this.y + this.height && this.y <= rect.y + rect.height);
      };
      p.isEmpty = function() {
        return this.width <= 0 || this.height <= 0;
      };
      p.clone = function() {
        return new Rectangle(this.x, this.y, this.width, this.height);
      };
      p.toString = function() {
        return "[Rectangle (x=" + this.x + " y=" + this.y + " width=" + this.width + " height=" + this.height + ")]";
      };
      createjs.Rectangle = Rectangle;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function ButtonHelper(target, outLabel, overLabel, downLabel, play, hitArea, hitLabel) {
        if (!target.addEventListener) {
          return;
        }
        this.target = target;
        this.overLabel = overLabel == null ? "over" : overLabel;
        this.outLabel = outLabel == null ? "out" : outLabel;
        this.downLabel = downLabel == null ? "down" : downLabel;
        this.play = play;
        this._isPressed = false;
        this._isOver = false;
        this._enabled = false;
        target.mouseChildren = false;
        this.enabled = true;
        this.handleEvent({});
        if (hitArea) {
          if (hitLabel) {
            hitArea.actionsEnabled = false;
            hitArea.gotoAndStop && hitArea.gotoAndStop(hitLabel);
          }
          target.hitArea = hitArea;
        }
      }
      var p = ButtonHelper.prototype;
      p.setEnabled = function(value) {
        if (value == this._enabled) {
          return;
        }
        var o = this.target;
        this._enabled = value;
        if (value) {
          o.cursor = "pointer";
          o.addEventListener("rollover", this);
          o.addEventListener("rollout", this);
          o.addEventListener("mousedown", this);
          o.addEventListener("pressup", this);
          if (o._reset) {
            o.__reset = o._reset;
            o._reset = this._reset;
          }
        } else {
          o.cursor = null;
          o.removeEventListener("rollover", this);
          o.removeEventListener("rollout", this);
          o.removeEventListener("mousedown", this);
          o.removeEventListener("pressup", this);
          if (o.__reset) {
            o._reset = o.__reset;
            delete(o.__reset);
          }
        }
      };
      p.getEnabled = function() {
        return this._enabled;
      };
      try {
        Object.defineProperties(p, {enabled: {
            get: p.getEnabled,
            set: p.setEnabled
          }});
      } catch (e) {}
      p.toString = function() {
        return "[ButtonHelper]";
      };
      p.handleEvent = function(evt) {
        var label,
            t = this.target,
            type = evt.type;
        if (type == "mousedown") {
          this._isPressed = true;
          label = this.downLabel;
        } else if (type == "pressup") {
          this._isPressed = false;
          label = this._isOver ? this.overLabel : this.outLabel;
        } else if (type == "rollover") {
          this._isOver = true;
          label = this._isPressed ? this.downLabel : this.overLabel;
        } else {
          this._isOver = false;
          label = this._isPressed ? this.overLabel : this.outLabel;
        }
        if (this.play) {
          t.gotoAndPlay && t.gotoAndPlay(label);
        } else {
          t.gotoAndStop && t.gotoAndStop(label);
        }
      };
      p._reset = function() {
        var p = this.paused;
        this.__reset();
        this.paused = p;
      };
      createjs.ButtonHelper = ButtonHelper;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Shadow(color, offsetX, offsetY, blur) {
        this.color = color || "black";
        this.offsetX = offsetX || 0;
        this.offsetY = offsetY || 0;
        this.blur = blur || 0;
      }
      var p = Shadow.prototype;
      Shadow.identity = new Shadow("transparent", 0, 0, 0);
      p.toString = function() {
        return "[Shadow]";
      };
      p.clone = function() {
        return new Shadow(this.color, this.offsetX, this.offsetY, this.blur);
      };
      createjs.Shadow = Shadow;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function SpriteSheet(data) {
        this.EventDispatcher_constructor();
        this.complete = true;
        this.framerate = 0;
        this._animations = null;
        this._frames = null;
        this._images = null;
        this._data = null;
        this._loadCount = 0;
        this._frameHeight = 0;
        this._frameWidth = 0;
        this._numFrames = 0;
        this._regX = 0;
        this._regY = 0;
        this._spacing = 0;
        this._margin = 0;
        this._parseData(data);
      }
      var p = createjs.extend(SpriteSheet, createjs.EventDispatcher);
      p.getAnimations = function() {
        return this._animations.slice();
      };
      try {
        Object.defineProperties(p, {animations: {get: p.getAnimations}});
      } catch (e) {}
      p.getNumFrames = function(animation) {
        if (animation == null) {
          return this._frames ? this._frames.length : this._numFrames || 0;
        } else {
          var data = this._data[animation];
          if (data == null) {
            return 0;
          } else {
            return data.frames.length;
          }
        }
      };
      p.getAnimation = function(name) {
        return this._data[name];
      };
      p.getFrame = function(frameIndex) {
        var frame;
        if (this._frames && (frame = this._frames[frameIndex])) {
          return frame;
        }
        return null;
      };
      p.getFrameBounds = function(frameIndex, rectangle) {
        var frame = this.getFrame(frameIndex);
        return frame ? (rectangle || new createjs.Rectangle()).setValues(-frame.regX, -frame.regY, frame.rect.width, frame.rect.height) : null;
      };
      p.toString = function() {
        return "[SpriteSheet]";
      };
      p.clone = function() {
        throw ("SpriteSheet cannot be cloned.");
      };
      p._parseData = function(data) {
        var i,
            l,
            o,
            a;
        if (data == null) {
          return;
        }
        this.framerate = data.framerate || 0;
        if (data.images && (l = data.images.length) > 0) {
          a = this._images = [];
          for (i = 0; i < l; i++) {
            var img = data.images[i];
            if (typeof img == "string") {
              var src = img;
              img = document.createElement("img");
              img.src = src;
            }
            a.push(img);
            if (!img.getContext && !img.naturalWidth) {
              this._loadCount++;
              this.complete = false;
              (function(o) {
                img.onload = function() {
                  o._handleImageLoad();
                };
              })(this);
            }
          }
        }
        if (data.frames == null) {} else if (data.frames instanceof Array) {
          this._frames = [];
          a = data.frames;
          for (i = 0, l = a.length; i < l; i++) {
            var arr = a[i];
            this._frames.push({
              image: this._images[arr[4] ? arr[4] : 0],
              rect: new createjs.Rectangle(arr[0], arr[1], arr[2], arr[3]),
              regX: arr[5] || 0,
              regY: arr[6] || 0
            });
          }
        } else {
          o = data.frames;
          this._frameWidth = o.width;
          this._frameHeight = o.height;
          this._regX = o.regX || 0;
          this._regY = o.regY || 0;
          this._spacing = o.spacing || 0;
          this._margin = o.margin || 0;
          this._numFrames = o.count;
          if (this._loadCount == 0) {
            this._calculateFrames();
          }
        }
        this._animations = [];
        if ((o = data.animations) != null) {
          this._data = {};
          var name;
          for (name in o) {
            var anim = {name: name};
            var obj = o[name];
            if (typeof obj == "number") {
              a = anim.frames = [obj];
            } else if (obj instanceof Array) {
              if (obj.length == 1) {
                anim.frames = [obj[0]];
              } else {
                anim.speed = obj[3];
                anim.next = obj[2];
                a = anim.frames = [];
                for (i = obj[0]; i <= obj[1]; i++) {
                  a.push(i);
                }
              }
            } else {
              anim.speed = obj.speed;
              anim.next = obj.next;
              var frames = obj.frames;
              a = anim.frames = (typeof frames == "number") ? [frames] : frames.slice(0);
            }
            if (anim.next === true || anim.next === undefined) {
              anim.next = name;
            }
            if (anim.next === false || (a.length < 2 && anim.next == name)) {
              anim.next = null;
            }
            if (!anim.speed) {
              anim.speed = 1;
            }
            this._animations.push(name);
            this._data[name] = anim;
          }
        }
      };
      p._handleImageLoad = function() {
        if (--this._loadCount == 0) {
          this._calculateFrames();
          this.complete = true;
          this.dispatchEvent("complete");
        }
      };
      p._calculateFrames = function() {
        if (this._frames || this._frameWidth == 0) {
          return;
        }
        this._frames = [];
        var maxFrames = this._numFrames || 100000;
        var frameCount = 0,
            frameWidth = this._frameWidth,
            frameHeight = this._frameHeight;
        var spacing = this._spacing,
            margin = this._margin;
        imgLoop: for (var i = 0,
            imgs = this._images; i < imgs.length; i++) {
          var img = imgs[i],
              imgW = img.width,
              imgH = img.height;
          var y = margin;
          while (y <= imgH - margin - frameHeight) {
            var x = margin;
            while (x <= imgW - margin - frameWidth) {
              if (frameCount >= maxFrames) {
                break imgLoop;
              }
              frameCount++;
              this._frames.push({
                image: img,
                rect: new createjs.Rectangle(x, y, frameWidth, frameHeight),
                regX: this._regX,
                regY: this._regY
              });
              x += frameWidth + spacing;
            }
            y += frameHeight + spacing;
          }
        }
        this._numFrames = frameCount;
      };
      createjs.SpriteSheet = createjs.promote(SpriteSheet, "EventDispatcher");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Graphics() {
        this.command = null;
        this._stroke = null;
        this._strokeStyle = null;
        this._oldStrokeStyle = null;
        this._strokeDash = null;
        this._oldStrokeDash = null;
        this._strokeIgnoreScale = false;
        this._fill = null;
        this._instructions = [];
        this._commitIndex = 0;
        this._activeInstructions = [];
        this._dirty = false;
        this._storeIndex = 0;
        this.clear();
      }
      var p = Graphics.prototype;
      var G = Graphics;
      Graphics.getRGB = function(r, g, b, alpha) {
        if (r != null && b == null) {
          alpha = g;
          b = r & 0xFF;
          g = r >> 8 & 0xFF;
          r = r >> 16 & 0xFF;
        }
        if (alpha == null) {
          return "rgb(" + r + "," + g + "," + b + ")";
        } else {
          return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
        }
      };
      Graphics.getHSL = function(hue, saturation, lightness, alpha) {
        if (alpha == null) {
          return "hsl(" + (hue % 360) + "," + saturation + "%," + lightness + "%)";
        } else {
          return "hsla(" + (hue % 360) + "," + saturation + "%," + lightness + "%," + alpha + ")";
        }
      };
      Graphics.BASE_64 = {
        "A": 0,
        "B": 1,
        "C": 2,
        "D": 3,
        "E": 4,
        "F": 5,
        "G": 6,
        "H": 7,
        "I": 8,
        "J": 9,
        "K": 10,
        "L": 11,
        "M": 12,
        "N": 13,
        "O": 14,
        "P": 15,
        "Q": 16,
        "R": 17,
        "S": 18,
        "T": 19,
        "U": 20,
        "V": 21,
        "W": 22,
        "X": 23,
        "Y": 24,
        "Z": 25,
        "a": 26,
        "b": 27,
        "c": 28,
        "d": 29,
        "e": 30,
        "f": 31,
        "g": 32,
        "h": 33,
        "i": 34,
        "j": 35,
        "k": 36,
        "l": 37,
        "m": 38,
        "n": 39,
        "o": 40,
        "p": 41,
        "q": 42,
        "r": 43,
        "s": 44,
        "t": 45,
        "u": 46,
        "v": 47,
        "w": 48,
        "x": 49,
        "y": 50,
        "z": 51,
        "0": 52,
        "1": 53,
        "2": 54,
        "3": 55,
        "4": 56,
        "5": 57,
        "6": 58,
        "7": 59,
        "8": 60,
        "9": 61,
        "+": 62,
        "/": 63
      };
      Graphics.STROKE_CAPS_MAP = ["butt", "round", "square"];
      Graphics.STROKE_JOINTS_MAP = ["miter", "round", "bevel"];
      var canvas = (createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas"));
      if (canvas.getContext) {
        Graphics._ctx = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
      }
      p.getInstructions = function() {
        this._updateInstructions();
        return this._instructions;
      };
      try {
        Object.defineProperties(p, {instructions: {get: p.getInstructions}});
      } catch (e) {}
      p.isEmpty = function() {
        return !(this._instructions.length || this._activeInstructions.length);
      };
      p.draw = function(ctx, data) {
        this._updateInstructions();
        var instr = this._instructions;
        for (var i = this._storeIndex,
            l = instr.length; i < l; i++) {
          instr[i].exec(ctx, data);
        }
      };
      p.drawAsPath = function(ctx) {
        this._updateInstructions();
        var instr,
            instrs = this._instructions;
        for (var i = this._storeIndex,
            l = instrs.length; i < l; i++) {
          if ((instr = instrs[i]).path !== false) {
            instr.exec(ctx);
          }
        }
      };
      p.moveTo = function(x, y) {
        return this.append(new G.MoveTo(x, y), true);
      };
      p.lineTo = function(x, y) {
        return this.append(new G.LineTo(x, y));
      };
      p.arcTo = function(x1, y1, x2, y2, radius) {
        return this.append(new G.ArcTo(x1, y1, x2, y2, radius));
      };
      p.arc = function(x, y, radius, startAngle, endAngle, anticlockwise) {
        return this.append(new G.Arc(x, y, radius, startAngle, endAngle, anticlockwise));
      };
      p.quadraticCurveTo = function(cpx, cpy, x, y) {
        return this.append(new G.QuadraticCurveTo(cpx, cpy, x, y));
      };
      p.bezierCurveTo = function(cp1x, cp1y, cp2x, cp2y, x, y) {
        return this.append(new G.BezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y));
      };
      p.rect = function(x, y, w, h) {
        return this.append(new G.Rect(x, y, w, h));
      };
      p.closePath = function() {
        return this._activeInstructions.length ? this.append(new G.ClosePath()) : this;
      };
      p.clear = function() {
        this._instructions.length = this._activeInstructions.length = this._commitIndex = 0;
        this._strokeStyle = this._oldStrokeStyle = this._stroke = this._fill = this._strokeDash = this._oldStrokeDash = null;
        this._dirty = this._strokeIgnoreScale = false;
        return this;
      };
      p.beginFill = function(color) {
        return this._setFill(color ? new G.Fill(color) : null);
      };
      p.beginLinearGradientFill = function(colors, ratios, x0, y0, x1, y1) {
        return this._setFill(new G.Fill().linearGradient(colors, ratios, x0, y0, x1, y1));
      };
      p.beginRadialGradientFill = function(colors, ratios, x0, y0, r0, x1, y1, r1) {
        return this._setFill(new G.Fill().radialGradient(colors, ratios, x0, y0, r0, x1, y1, r1));
      };
      p.beginBitmapFill = function(image, repetition, matrix) {
        return this._setFill(new G.Fill(null, matrix).bitmap(image, repetition));
      };
      p.endFill = function() {
        return this.beginFill();
      };
      p.setStrokeStyle = function(thickness, caps, joints, miterLimit, ignoreScale) {
        this._updateInstructions(true);
        this._strokeStyle = this.command = new G.StrokeStyle(thickness, caps, joints, miterLimit, ignoreScale);
        if (this._stroke) {
          this._stroke.ignoreScale = ignoreScale;
        }
        this._strokeIgnoreScale = ignoreScale;
        return this;
      };
      p.setStrokeDash = function(segments, offset) {
        this._updateInstructions(true);
        this._strokeDash = this.command = new G.StrokeDash(segments, offset);
        return this;
      };
      p.beginStroke = function(color) {
        return this._setStroke(color ? new G.Stroke(color) : null);
      };
      p.beginLinearGradientStroke = function(colors, ratios, x0, y0, x1, y1) {
        return this._setStroke(new G.Stroke().linearGradient(colors, ratios, x0, y0, x1, y1));
      };
      p.beginRadialGradientStroke = function(colors, ratios, x0, y0, r0, x1, y1, r1) {
        return this._setStroke(new G.Stroke().radialGradient(colors, ratios, x0, y0, r0, x1, y1, r1));
      };
      p.beginBitmapStroke = function(image, repetition) {
        return this._setStroke(new G.Stroke().bitmap(image, repetition));
      };
      p.endStroke = function() {
        return this.beginStroke();
      };
      p.curveTo = p.quadraticCurveTo;
      p.drawRect = p.rect;
      p.drawRoundRect = function(x, y, w, h, radius) {
        return this.drawRoundRectComplex(x, y, w, h, radius, radius, radius, radius);
      };
      p.drawRoundRectComplex = function(x, y, w, h, radiusTL, radiusTR, radiusBR, radiusBL) {
        return this.append(new G.RoundRect(x, y, w, h, radiusTL, radiusTR, radiusBR, radiusBL));
      };
      p.drawCircle = function(x, y, radius) {
        return this.append(new G.Circle(x, y, radius));
      };
      p.drawEllipse = function(x, y, w, h) {
        return this.append(new G.Ellipse(x, y, w, h));
      };
      p.drawPolyStar = function(x, y, radius, sides, pointSize, angle) {
        return this.append(new G.PolyStar(x, y, radius, sides, pointSize, angle));
      };
      p.append = function(command, clean) {
        this._activeInstructions.push(command);
        this.command = command;
        if (!clean) {
          this._dirty = true;
        }
        return this;
      };
      p.decodePath = function(str) {
        var instructions = [this.moveTo, this.lineTo, this.quadraticCurveTo, this.bezierCurveTo, this.closePath];
        var paramCount = [2, 2, 4, 6, 0];
        var i = 0,
            l = str.length;
        var params = [];
        var x = 0,
            y = 0;
        var base64 = Graphics.BASE_64;
        while (i < l) {
          var c = str.charAt(i);
          var n = base64[c];
          var fi = n >> 3;
          var f = instructions[fi];
          if (!f || (n & 3)) {
            throw ("bad path data (@" + i + "): " + c);
          }
          var pl = paramCount[fi];
          if (!fi) {
            x = y = 0;
          }
          params.length = 0;
          i++;
          var charCount = (n >> 2 & 1) + 2;
          for (var p = 0; p < pl; p++) {
            var num = base64[str.charAt(i)];
            var sign = (num >> 5) ? -1 : 1;
            num = ((num & 31) << 6) | (base64[str.charAt(i + 1)]);
            if (charCount == 3) {
              num = (num << 6) | (base64[str.charAt(i + 2)]);
            }
            num = sign * num / 10;
            if (p % 2) {
              x = (num += x);
            } else {
              y = (num += y);
            }
            params[p] = num;
            i += charCount;
          }
          f.apply(this, params);
        }
        return this;
      };
      p.store = function() {
        this._updateInstructions(true);
        this._storeIndex = this._instructions.length;
        return this;
      };
      p.unstore = function() {
        this._storeIndex = 0;
        return this;
      };
      p.clone = function() {
        var o = new Graphics();
        o.command = this.command;
        o._stroke = this._stroke;
        o._strokeStyle = this._strokeStyle;
        o._strokeDash = this._strokeDash;
        o._strokeIgnoreScale = this._strokeIgnoreScale;
        o._fill = this._fill;
        o._instructions = this._instructions.slice();
        o._commitIndex = this._commitIndex;
        o._activeInstructions = this._activeInstructions.slice();
        o._dirty = this._dirty;
        o._storeIndex = this._storeIndex;
        return o;
      };
      p.toString = function() {
        return "[Graphics]";
      };
      p.mt = p.moveTo;
      p.lt = p.lineTo;
      p.at = p.arcTo;
      p.bt = p.bezierCurveTo;
      p.qt = p.quadraticCurveTo;
      p.a = p.arc;
      p.r = p.rect;
      p.cp = p.closePath;
      p.c = p.clear;
      p.f = p.beginFill;
      p.lf = p.beginLinearGradientFill;
      p.rf = p.beginRadialGradientFill;
      p.bf = p.beginBitmapFill;
      p.ef = p.endFill;
      p.ss = p.setStrokeStyle;
      p.sd = p.setStrokeDash;
      p.s = p.beginStroke;
      p.ls = p.beginLinearGradientStroke;
      p.rs = p.beginRadialGradientStroke;
      p.bs = p.beginBitmapStroke;
      p.es = p.endStroke;
      p.dr = p.drawRect;
      p.rr = p.drawRoundRect;
      p.rc = p.drawRoundRectComplex;
      p.dc = p.drawCircle;
      p.de = p.drawEllipse;
      p.dp = p.drawPolyStar;
      p.p = p.decodePath;
      p._updateInstructions = function(commit) {
        var instr = this._instructions,
            active = this._activeInstructions,
            commitIndex = this._commitIndex;
        if (this._dirty && active.length) {
          instr.length = commitIndex;
          instr.push(Graphics.beginCmd);
          var l = active.length,
              ll = instr.length;
          instr.length = ll + l;
          for (var i = 0; i < l; i++) {
            instr[i + ll] = active[i];
          }
          if (this._fill) {
            instr.push(this._fill);
          }
          if (this._stroke) {
            if (this._strokeDash !== this._oldStrokeDash) {
              this._oldStrokeDash = this._strokeDash;
              instr.push(this._strokeDash);
            }
            if (this._strokeStyle !== this._oldStrokeStyle) {
              this._oldStrokeStyle = this._strokeStyle;
              instr.push(this._strokeStyle);
            }
            instr.push(this._stroke);
          }
          this._dirty = false;
        }
        if (commit) {
          active.length = 0;
          this._commitIndex = instr.length;
        }
      };
      p._setFill = function(fill) {
        this._updateInstructions(true);
        this.command = this._fill = fill;
        return this;
      };
      p._setStroke = function(stroke) {
        this._updateInstructions(true);
        if (this.command = this._stroke = stroke) {
          stroke.ignoreScale = this._strokeIgnoreScale;
        }
        return this;
      };
      (G.LineTo = function(x, y) {
        this.x = x;
        this.y = y;
      }).prototype.exec = function(ctx) {
        ctx.lineTo(this.x, this.y);
      };
      (G.MoveTo = function(x, y) {
        this.x = x;
        this.y = y;
      }).prototype.exec = function(ctx) {
        ctx.moveTo(this.x, this.y);
      };
      (G.ArcTo = function(x1, y1, x2, y2, radius) {
        this.x1 = x1;
        this.y1 = y1;
        this.x2 = x2;
        this.y2 = y2;
        this.radius = radius;
      }).prototype.exec = function(ctx) {
        ctx.arcTo(this.x1, this.y1, this.x2, this.y2, this.radius);
      };
      (G.Arc = function(x, y, radius, startAngle, endAngle, anticlockwise) {
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.startAngle = startAngle;
        this.endAngle = endAngle;
        this.anticlockwise = !!anticlockwise;
      }).prototype.exec = function(ctx) {
        ctx.arc(this.x, this.y, this.radius, this.startAngle, this.endAngle, this.anticlockwise);
      };
      (G.QuadraticCurveTo = function(cpx, cpy, x, y) {
        this.cpx = cpx;
        this.cpy = cpy;
        this.x = x;
        this.y = y;
      }).prototype.exec = function(ctx) {
        ctx.quadraticCurveTo(this.cpx, this.cpy, this.x, this.y);
      };
      (G.BezierCurveTo = function(cp1x, cp1y, cp2x, cp2y, x, y) {
        this.cp1x = cp1x;
        this.cp1y = cp1y;
        this.cp2x = cp2x;
        this.cp2y = cp2y;
        this.x = x;
        this.y = y;
      }).prototype.exec = function(ctx) {
        ctx.bezierCurveTo(this.cp1x, this.cp1y, this.cp2x, this.cp2y, this.x, this.y);
      };
      (G.Rect = function(x, y, w, h) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
      }).prototype.exec = function(ctx) {
        ctx.rect(this.x, this.y, this.w, this.h);
      };
      (G.ClosePath = function() {}).prototype.exec = function(ctx) {
        ctx.closePath();
      };
      (G.BeginPath = function() {}).prototype.exec = function(ctx) {
        ctx.beginPath();
      };
      p = (G.Fill = function(style, matrix) {
        this.style = style;
        this.matrix = matrix;
      }).prototype;
      p.exec = function(ctx) {
        if (!this.style) {
          return;
        }
        ctx.fillStyle = this.style;
        var mtx = this.matrix;
        if (mtx) {
          ctx.save();
          ctx.transform(mtx.a, mtx.b, mtx.c, mtx.d, mtx.tx, mtx.ty);
        }
        ctx.fill();
        if (mtx) {
          ctx.restore();
        }
      };
      p.linearGradient = function(colors, ratios, x0, y0, x1, y1) {
        var o = this.style = Graphics._ctx.createLinearGradient(x0, y0, x1, y1);
        for (var i = 0,
            l = colors.length; i < l; i++) {
          o.addColorStop(ratios[i], colors[i]);
        }
        o.props = {
          colors: colors,
          ratios: ratios,
          x0: x0,
          y0: y0,
          x1: x1,
          y1: y1,
          type: "linear"
        };
        return this;
      };
      p.radialGradient = function(colors, ratios, x0, y0, r0, x1, y1, r1) {
        var o = this.style = Graphics._ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
        for (var i = 0,
            l = colors.length; i < l; i++) {
          o.addColorStop(ratios[i], colors[i]);
        }
        o.props = {
          colors: colors,
          ratios: ratios,
          x0: x0,
          y0: y0,
          r0: r0,
          x1: x1,
          y1: y1,
          r1: r1,
          type: "radial"
        };
        return this;
      };
      p.bitmap = function(image, repetition) {
        if (image.naturalWidth || image.getContext || image.readyState >= 2) {
          var o = this.style = Graphics._ctx.createPattern(image, repetition || "");
          o.props = {
            image: image,
            repetition: repetition,
            type: "bitmap"
          };
        }
        return this;
      };
      p.path = false;
      p = (G.Stroke = function(style, ignoreScale) {
        this.style = style;
        this.ignoreScale = ignoreScale;
      }).prototype;
      p.exec = function(ctx) {
        if (!this.style) {
          return;
        }
        ctx.strokeStyle = this.style;
        if (this.ignoreScale) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.stroke();
        if (this.ignoreScale) {
          ctx.restore();
        }
      };
      p.linearGradient = G.Fill.prototype.linearGradient;
      p.radialGradient = G.Fill.prototype.radialGradient;
      p.bitmap = G.Fill.prototype.bitmap;
      p.path = false;
      p = (G.StrokeStyle = function(width, caps, joints, miterLimit) {
        this.width = width;
        this.caps = caps;
        this.joints = joints;
        this.miterLimit = miterLimit;
      }).prototype;
      p.exec = function(ctx) {
        ctx.lineWidth = (this.width == null ? "1" : this.width);
        ctx.lineCap = (this.caps == null ? "butt" : (isNaN(this.caps) ? this.caps : Graphics.STROKE_CAPS_MAP[this.caps]));
        ctx.lineJoin = (this.joints == null ? "miter" : (isNaN(this.joints) ? this.joints : Graphics.STROKE_JOINTS_MAP[this.joints]));
        ctx.miterLimit = (this.miterLimit == null ? "10" : this.miterLimit);
      };
      p.path = false;
      (G.StrokeDash = function(segments, offset) {
        this.segments = segments;
        this.offset = offset || 0;
      }).prototype.exec = function(ctx) {
        if (ctx.setLineDash) {
          ctx.setLineDash(this.segments || G.StrokeDash.EMPTY_SEGMENTS);
          ctx.lineDashOffset = this.offset || 0;
        }
      };
      G.StrokeDash.EMPTY_SEGMENTS = [];
      (G.RoundRect = function(x, y, w, h, radiusTL, radiusTR, radiusBR, radiusBL) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.radiusTL = radiusTL;
        this.radiusTR = radiusTR;
        this.radiusBR = radiusBR;
        this.radiusBL = radiusBL;
      }).prototype.exec = function(ctx) {
        var max = (w < h ? w : h) / 2;
        var mTL = 0,
            mTR = 0,
            mBR = 0,
            mBL = 0;
        var x = this.x,
            y = this.y,
            w = this.w,
            h = this.h;
        var rTL = this.radiusTL,
            rTR = this.radiusTR,
            rBR = this.radiusBR,
            rBL = this.radiusBL;
        if (rTL < 0) {
          rTL *= (mTL = -1);
        }
        if (rTL > max) {
          rTL = max;
        }
        if (rTR < 0) {
          rTR *= (mTR = -1);
        }
        if (rTR > max) {
          rTR = max;
        }
        if (rBR < 0) {
          rBR *= (mBR = -1);
        }
        if (rBR > max) {
          rBR = max;
        }
        if (rBL < 0) {
          rBL *= (mBL = -1);
        }
        if (rBL > max) {
          rBL = max;
        }
        ctx.moveTo(x + w - rTR, y);
        ctx.arcTo(x + w + rTR * mTR, y - rTR * mTR, x + w, y + rTR, rTR);
        ctx.lineTo(x + w, y + h - rBR);
        ctx.arcTo(x + w + rBR * mBR, y + h + rBR * mBR, x + w - rBR, y + h, rBR);
        ctx.lineTo(x + rBL, y + h);
        ctx.arcTo(x - rBL * mBL, y + h + rBL * mBL, x, y + h - rBL, rBL);
        ctx.lineTo(x, y + rTL);
        ctx.arcTo(x - rTL * mTL, y - rTL * mTL, x + rTL, y, rTL);
        ctx.closePath();
      };
      (G.Circle = function(x, y, radius) {
        this.x = x;
        this.y = y;
        this.radius = radius;
      }).prototype.exec = function(ctx) {
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      };
      (G.Ellipse = function(x, y, w, h) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
      }).prototype.exec = function(ctx) {
        var x = this.x,
            y = this.y;
        var w = this.w,
            h = this.h;
        var k = 0.5522848;
        var ox = (w / 2) * k;
        var oy = (h / 2) * k;
        var xe = x + w;
        var ye = y + h;
        var xm = x + w / 2;
        var ym = y + h / 2;
        ctx.moveTo(x, ym);
        ctx.bezierCurveTo(x, ym - oy, xm - ox, y, xm, y);
        ctx.bezierCurveTo(xm + ox, y, xe, ym - oy, xe, ym);
        ctx.bezierCurveTo(xe, ym + oy, xm + ox, ye, xm, ye);
        ctx.bezierCurveTo(xm - ox, ye, x, ym + oy, x, ym);
      };
      (G.PolyStar = function(x, y, radius, sides, pointSize, angle) {
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.sides = sides;
        this.pointSize = pointSize;
        this.angle = angle;
      }).prototype.exec = function(ctx) {
        var x = this.x,
            y = this.y;
        var radius = this.radius;
        var angle = (this.angle || 0) / 180 * Math.PI;
        var sides = this.sides;
        var ps = 1 - (this.pointSize || 0);
        var a = Math.PI / sides;
        ctx.moveTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
        for (var i = 0; i < sides; i++) {
          angle += a;
          if (ps != 1) {
            ctx.lineTo(x + Math.cos(angle) * radius * ps, y + Math.sin(angle) * radius * ps);
          }
          angle += a;
          ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
        }
        ctx.closePath();
      };
      Graphics.beginCmd = new G.BeginPath();
      createjs.Graphics = Graphics;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function DisplayObject() {
        this.EventDispatcher_constructor();
        this.alpha = 1;
        this.cacheCanvas = null;
        this.cacheID = 0;
        this.id = createjs.UID.get();
        this.mouseEnabled = true;
        this.tickEnabled = true;
        this.name = null;
        this.parent = null;
        this.regX = 0;
        this.regY = 0;
        this.rotation = 0;
        this.scaleX = 1;
        this.scaleY = 1;
        this.skewX = 0;
        this.skewY = 0;
        this.shadow = null;
        this.visible = true;
        this.x = 0;
        this.y = 0;
        this.transformMatrix = null;
        this.compositeOperation = null;
        this.snapToPixel = true;
        this.filters = null;
        this.mask = null;
        this.hitArea = null;
        this.cursor = null;
        this._cacheOffsetX = 0;
        this._cacheOffsetY = 0;
        this._filterOffsetX = 0;
        this._filterOffsetY = 0;
        this._cacheScale = 1;
        this._cacheDataURLID = 0;
        this._cacheDataURL = null;
        this._props = new createjs.DisplayProps();
        this._rectangle = new createjs.Rectangle();
        this._bounds = null;
      }
      var p = createjs.extend(DisplayObject, createjs.EventDispatcher);
      DisplayObject._MOUSE_EVENTS = ["click", "dblclick", "mousedown", "mouseout", "mouseover", "pressmove", "pressup", "rollout", "rollover"];
      DisplayObject.suppressCrossDomainErrors = false;
      DisplayObject._snapToPixelEnabled = false;
      var canvas = createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas");
      if (canvas.getContext) {
        DisplayObject._hitTestCanvas = canvas;
        DisplayObject._hitTestContext = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
      }
      DisplayObject._nextCacheID = 1;
      p.getStage = function() {
        var o = this,
            _Stage = createjs["Stage"];
        while (o.parent) {
          o = o.parent;
        }
        if (o instanceof _Stage) {
          return o;
        }
        return null;
      };
      try {
        Object.defineProperties(p, {stage: {get: p.getStage}});
      } catch (e) {}
      p.isVisible = function() {
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0);
      };
      p.draw = function(ctx, ignoreCache) {
        var cacheCanvas = this.cacheCanvas;
        if (ignoreCache || !cacheCanvas) {
          return false;
        }
        var scale = this._cacheScale;
        ctx.drawImage(cacheCanvas, this._cacheOffsetX + this._filterOffsetX, this._cacheOffsetY + this._filterOffsetY, cacheCanvas.width / scale, cacheCanvas.height / scale);
        return true;
      };
      p.updateContext = function(ctx) {
        var o = this,
            mask = o.mask,
            mtx = o._props.matrix;
        if (mask && mask.graphics && !mask.graphics.isEmpty()) {
          mask.getMatrix(mtx);
          ctx.transform(mtx.a, mtx.b, mtx.c, mtx.d, mtx.tx, mtx.ty);
          mask.graphics.drawAsPath(ctx);
          ctx.clip();
          mtx.invert();
          ctx.transform(mtx.a, mtx.b, mtx.c, mtx.d, mtx.tx, mtx.ty);
        }
        this.getMatrix(mtx);
        var tx = mtx.tx,
            ty = mtx.ty;
        if (DisplayObject._snapToPixelEnabled && o.snapToPixel) {
          tx = tx + (tx < 0 ? -0.5 : 0.5) | 0;
          ty = ty + (ty < 0 ? -0.5 : 0.5) | 0;
        }
        ctx.transform(mtx.a, mtx.b, mtx.c, mtx.d, tx, ty);
        ctx.globalAlpha *= o.alpha;
        if (o.compositeOperation) {
          ctx.globalCompositeOperation = o.compositeOperation;
        }
        if (o.shadow) {
          this._applyShadow(ctx, o.shadow);
        }
      };
      p.cache = function(x, y, width, height, scale) {
        scale = scale || 1;
        if (!this.cacheCanvas) {
          this.cacheCanvas = createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas");
        }
        this._cacheWidth = width;
        this._cacheHeight = height;
        this._cacheOffsetX = x;
        this._cacheOffsetY = y;
        this._cacheScale = scale;
        this.updateCache();
      };
      p.updateCache = function(compositeOperation) {
        var cacheCanvas = this.cacheCanvas;
        if (!cacheCanvas) {
          throw "cache() must be called before updateCache()";
        }
        var scale = this._cacheScale,
            offX = this._cacheOffsetX * scale,
            offY = this._cacheOffsetY * scale;
        var w = this._cacheWidth,
            h = this._cacheHeight,
            ctx = cacheCanvas.getContext("2d");
        var fBounds = this._getFilterBounds();
        offX += (this._filterOffsetX = fBounds.x);
        offY += (this._filterOffsetY = fBounds.y);
        w = Math.ceil(w * scale) + fBounds.width;
        h = Math.ceil(h * scale) + fBounds.height;
        if (w != cacheCanvas.width || h != cacheCanvas.height) {
          cacheCanvas.width = w;
          cacheCanvas.height = h;
        } else if (!compositeOperation) {
          ctx.clearRect(0, 0, w + 1, h + 1);
        }
        ctx.save();
        ctx.globalCompositeOperation = compositeOperation;
        ctx.setTransform(scale, 0, 0, scale, -offX, -offY);
        this.draw(ctx, true);
        this._applyFilters();
        ctx.restore();
        this.cacheID = DisplayObject._nextCacheID++;
      };
      p.uncache = function() {
        this._cacheDataURL = this.cacheCanvas = null;
        this.cacheID = this._cacheOffsetX = this._cacheOffsetY = this._filterOffsetX = this._filterOffsetY = 0;
        this._cacheScale = 1;
      };
      p.getCacheDataURL = function() {
        if (!this.cacheCanvas) {
          return null;
        }
        if (this.cacheID != this._cacheDataURLID) {
          this._cacheDataURL = this.cacheCanvas.toDataURL();
        }
        return this._cacheDataURL;
      };
      p.localToGlobal = function(x, y, pt) {
        return this.getConcatenatedMatrix(this._props.matrix).transformPoint(x, y, pt || new createjs.Point());
      };
      p.globalToLocal = function(x, y, pt) {
        return this.getConcatenatedMatrix(this._props.matrix).invert().transformPoint(x, y, pt || new createjs.Point());
      };
      p.localToLocal = function(x, y, target, pt) {
        pt = this.localToGlobal(x, y, pt);
        return target.globalToLocal(pt.x, pt.y, pt);
      };
      p.setTransform = function(x, y, scaleX, scaleY, rotation, skewX, skewY, regX, regY) {
        this.x = x || 0;
        this.y = y || 0;
        this.scaleX = scaleX == null ? 1 : scaleX;
        this.scaleY = scaleY == null ? 1 : scaleY;
        this.rotation = rotation || 0;
        this.skewX = skewX || 0;
        this.skewY = skewY || 0;
        this.regX = regX || 0;
        this.regY = regY || 0;
        return this;
      };
      p.getMatrix = function(matrix) {
        var o = this,
            mtx = matrix && matrix.identity() || new createjs.Matrix2D();
        return o.transformMatrix ? mtx.copy(o.transformMatrix) : mtx.appendTransform(o.x, o.y, o.scaleX, o.scaleY, o.rotation, o.skewX, o.skewY, o.regX, o.regY);
      };
      p.getConcatenatedMatrix = function(matrix) {
        var o = this,
            mtx = this.getMatrix(matrix);
        while (o = o.parent) {
          mtx.prependMatrix(o.getMatrix(o._props.matrix));
        }
        return mtx;
      };
      p.getConcatenatedDisplayProps = function(props) {
        props = props ? props.identity() : new createjs.DisplayProps();
        var o = this,
            mtx = o.getMatrix(props.matrix);
        do {
          props.prepend(o.visible, o.alpha, o.shadow, o.compositeOperation);
          if (o != this) {
            mtx.prependMatrix(o.getMatrix(o._props.matrix));
          }
        } while (o = o.parent);
        return props;
      };
      p.hitTest = function(x, y) {
        var ctx = DisplayObject._hitTestContext;
        ctx.setTransform(1, 0, 0, 1, -x, -y);
        this.draw(ctx);
        var hit = this._testHit(ctx);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 2, 2);
        return hit;
      };
      p.set = function(props) {
        for (var n in props) {
          this[n] = props[n];
        }
        return this;
      };
      p.getBounds = function() {
        if (this._bounds) {
          return this._rectangle.copy(this._bounds);
        }
        var cacheCanvas = this.cacheCanvas;
        if (cacheCanvas) {
          var scale = this._cacheScale;
          return this._rectangle.setValues(this._cacheOffsetX, this._cacheOffsetY, cacheCanvas.width / scale, cacheCanvas.height / scale);
        }
        return null;
      };
      p.getTransformedBounds = function() {
        return this._getBounds();
      };
      p.setBounds = function(x, y, width, height) {
        if (x == null) {
          this._bounds = x;
        }
        this._bounds = (this._bounds || new createjs.Rectangle()).setValues(x, y, width, height);
      };
      p.clone = function() {
        return this._cloneProps(new DisplayObject());
      };
      p.toString = function() {
        return "[DisplayObject (name=" + this.name + ")]";
      };
      p._cloneProps = function(o) {
        o.alpha = this.alpha;
        o.mouseEnabled = this.mouseEnabled;
        o.tickEnabled = this.tickEnabled;
        o.name = this.name;
        o.regX = this.regX;
        o.regY = this.regY;
        o.rotation = this.rotation;
        o.scaleX = this.scaleX;
        o.scaleY = this.scaleY;
        o.shadow = this.shadow;
        o.skewX = this.skewX;
        o.skewY = this.skewY;
        o.visible = this.visible;
        o.x = this.x;
        o.y = this.y;
        o.compositeOperation = this.compositeOperation;
        o.snapToPixel = this.snapToPixel;
        o.filters = this.filters == null ? null : this.filters.slice(0);
        o.mask = this.mask;
        o.hitArea = this.hitArea;
        o.cursor = this.cursor;
        o._bounds = this._bounds;
        return o;
      };
      p._applyShadow = function(ctx, shadow) {
        shadow = shadow || Shadow.identity;
        ctx.shadowColor = shadow.color;
        ctx.shadowOffsetX = shadow.offsetX;
        ctx.shadowOffsetY = shadow.offsetY;
        ctx.shadowBlur = shadow.blur;
      };
      p._tick = function(evtObj) {
        var ls = this._listeners;
        if (ls && ls["tick"]) {
          evtObj.target = null;
          evtObj.propagationStopped = evtObj.immediatePropagationStopped = false;
          this.dispatchEvent(evtObj);
        }
      };
      p._testHit = function(ctx) {
        try {
          var hit = ctx.getImageData(0, 0, 1, 1).data[3] > 1;
        } catch (e) {
          if (!DisplayObject.suppressCrossDomainErrors) {
            throw "An error has occurred. This is most likely due to security restrictions on reading canvas pixel data with local or cross-domain images.";
          }
        }
        return hit;
      };
      p._applyFilters = function() {
        if (!this.filters || this.filters.length == 0 || !this.cacheCanvas) {
          return;
        }
        var l = this.filters.length;
        var ctx = this.cacheCanvas.getContext("2d");
        var w = this.cacheCanvas.width;
        var h = this.cacheCanvas.height;
        for (var i = 0; i < l; i++) {
          this.filters[i].applyFilter(ctx, 0, 0, w, h);
        }
      };
      p._getFilterBounds = function(rect) {
        var l,
            filters = this.filters,
            bounds = this._rectangle.setValues(0, 0, 0, 0);
        if (!filters || !(l = filters.length)) {
          return bounds;
        }
        for (var i = 0; i < l; i++) {
          var f = this.filters[i];
          f.getBounds && f.getBounds(bounds);
        }
        return bounds;
      };
      p._getBounds = function(matrix, ignoreTransform) {
        return this._transformBounds(this.getBounds(), matrix, ignoreTransform);
      };
      p._transformBounds = function(bounds, matrix, ignoreTransform) {
        if (!bounds) {
          return bounds;
        }
        var x = bounds.x,
            y = bounds.y,
            width = bounds.width,
            height = bounds.height,
            mtx = this._props.matrix;
        mtx = ignoreTransform ? mtx.identity() : this.getMatrix(mtx);
        if (x || y) {
          mtx.appendTransform(0, 0, 1, 1, 0, 0, 0, -x, -y);
        }
        if (matrix) {
          mtx.prependMatrix(matrix);
        }
        var x_a = width * mtx.a,
            x_b = width * mtx.b;
        var y_c = height * mtx.c,
            y_d = height * mtx.d;
        var tx = mtx.tx,
            ty = mtx.ty;
        var minX = tx,
            maxX = tx,
            minY = ty,
            maxY = ty;
        if ((x = x_a + tx) < minX) {
          minX = x;
        } else if (x > maxX) {
          maxX = x;
        }
        if ((x = x_a + y_c + tx) < minX) {
          minX = x;
        } else if (x > maxX) {
          maxX = x;
        }
        if ((x = y_c + tx) < minX) {
          minX = x;
        } else if (x > maxX) {
          maxX = x;
        }
        if ((y = x_b + ty) < minY) {
          minY = y;
        } else if (y > maxY) {
          maxY = y;
        }
        if ((y = x_b + y_d + ty) < minY) {
          minY = y;
        } else if (y > maxY) {
          maxY = y;
        }
        if ((y = y_d + ty) < minY) {
          minY = y;
        } else if (y > maxY) {
          maxY = y;
        }
        return bounds.setValues(minX, minY, maxX - minX, maxY - minY);
      };
      p._hasMouseEventListener = function() {
        var evts = DisplayObject._MOUSE_EVENTS;
        for (var i = 0,
            l = evts.length; i < l; i++) {
          if (this.hasEventListener(evts[i])) {
            return true;
          }
        }
        return !!this.cursor;
      };
      createjs.DisplayObject = createjs.promote(DisplayObject, "EventDispatcher");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Container() {
        this.DisplayObject_constructor();
        this.children = [];
        this.mouseChildren = true;
        this.tickChildren = true;
      }
      var p = createjs.extend(Container, createjs.DisplayObject);
      p.getNumChildren = function() {
        return this.children.length;
      };
      try {
        Object.defineProperties(p, {numChildren: {get: p.getNumChildren}});
      } catch (e) {}
      p.initialize = Container;
      p.isVisible = function() {
        var hasContent = this.cacheCanvas || this.children.length;
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0 && hasContent);
      };
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache)) {
          return true;
        }
        var list = this.children.slice();
        for (var i = 0,
            l = list.length; i < l; i++) {
          var child = list[i];
          if (!child.isVisible()) {
            continue;
          }
          ctx.save();
          child.updateContext(ctx);
          child.draw(ctx);
          ctx.restore();
        }
        return true;
      };
      p.addChild = function(child) {
        if (child == null) {
          return child;
        }
        var l = arguments.length;
        if (l > 1) {
          for (var i = 0; i < l; i++) {
            this.addChild(arguments[i]);
          }
          return arguments[l - 1];
        }
        if (child.parent) {
          child.parent.removeChild(child);
        }
        child.parent = this;
        this.children.push(child);
        child.dispatchEvent("added");
        return child;
      };
      p.addChildAt = function(child, index) {
        var l = arguments.length;
        var indx = arguments[l - 1];
        if (indx < 0 || indx > this.children.length) {
          return arguments[l - 2];
        }
        if (l > 2) {
          for (var i = 0; i < l - 1; i++) {
            this.addChildAt(arguments[i], indx + i);
          }
          return arguments[l - 2];
        }
        if (child.parent) {
          child.parent.removeChild(child);
        }
        child.parent = this;
        this.children.splice(index, 0, child);
        child.dispatchEvent("added");
        return child;
      };
      p.removeChild = function(child) {
        var l = arguments.length;
        if (l > 1) {
          var good = true;
          for (var i = 0; i < l; i++) {
            good = good && this.removeChild(arguments[i]);
          }
          return good;
        }
        return this.removeChildAt(createjs.indexOf(this.children, child));
      };
      p.removeChildAt = function(index) {
        var l = arguments.length;
        if (l > 1) {
          var a = [];
          for (var i = 0; i < l; i++) {
            a[i] = arguments[i];
          }
          a.sort(function(a, b) {
            return b - a;
          });
          var good = true;
          for (var i = 0; i < l; i++) {
            good = good && this.removeChildAt(a[i]);
          }
          return good;
        }
        if (index < 0 || index > this.children.length - 1) {
          return false;
        }
        var child = this.children[index];
        if (child) {
          child.parent = null;
        }
        this.children.splice(index, 1);
        child.dispatchEvent("removed");
        return true;
      };
      p.removeAllChildren = function() {
        var kids = this.children;
        while (kids.length) {
          this.removeChildAt(0);
        }
      };
      p.getChildAt = function(index) {
        return this.children[index];
      };
      p.getChildByName = function(name) {
        var kids = this.children;
        for (var i = 0,
            l = kids.length; i < l; i++) {
          if (kids[i].name == name) {
            return kids[i];
          }
        }
        return null;
      };
      p.sortChildren = function(sortFunction) {
        this.children.sort(sortFunction);
      };
      p.getChildIndex = function(child) {
        return createjs.indexOf(this.children, child);
      };
      p.swapChildrenAt = function(index1, index2) {
        var kids = this.children;
        var o1 = kids[index1];
        var o2 = kids[index2];
        if (!o1 || !o2) {
          return;
        }
        kids[index1] = o2;
        kids[index2] = o1;
      };
      p.swapChildren = function(child1, child2) {
        var kids = this.children;
        var index1,
            index2;
        for (var i = 0,
            l = kids.length; i < l; i++) {
          if (kids[i] == child1) {
            index1 = i;
          }
          if (kids[i] == child2) {
            index2 = i;
          }
          if (index1 != null && index2 != null) {
            break;
          }
        }
        if (i == l) {
          return;
        }
        kids[index1] = child2;
        kids[index2] = child1;
      };
      p.setChildIndex = function(child, index) {
        var kids = this.children,
            l = kids.length;
        if (child.parent != this || index < 0 || index >= l) {
          return;
        }
        for (var i = 0; i < l; i++) {
          if (kids[i] == child) {
            break;
          }
        }
        if (i == l || i == index) {
          return;
        }
        kids.splice(i, 1);
        kids.splice(index, 0, child);
      };
      p.contains = function(child) {
        while (child) {
          if (child == this) {
            return true;
          }
          child = child.parent;
        }
        return false;
      };
      p.hitTest = function(x, y) {
        return (this.getObjectUnderPoint(x, y) != null);
      };
      p.getObjectsUnderPoint = function(x, y, mode) {
        var arr = [];
        var pt = this.localToGlobal(x, y);
        this._getObjectsUnderPoint(pt.x, pt.y, arr, mode > 0, mode == 1);
        return arr;
      };
      p.getObjectUnderPoint = function(x, y, mode) {
        var pt = this.localToGlobal(x, y);
        return this._getObjectsUnderPoint(pt.x, pt.y, null, mode > 0, mode == 1);
      };
      p.getBounds = function() {
        return this._getBounds(null, true);
      };
      p.getTransformedBounds = function() {
        return this._getBounds();
      };
      p.clone = function(recursive) {
        var o = this._cloneProps(new Container());
        if (recursive) {
          this._cloneChildren(o);
        }
        return o;
      };
      p.toString = function() {
        return "[Container (name=" + this.name + ")]";
      };
      p._tick = function(evtObj) {
        if (this.tickChildren) {
          for (var i = this.children.length - 1; i >= 0; i--) {
            var child = this.children[i];
            if (child.tickEnabled && child._tick) {
              child._tick(evtObj);
            }
          }
        }
        this.DisplayObject__tick(evtObj);
      };
      p._cloneChildren = function(o) {
        if (o.children.length) {
          o.removeAllChildren();
        }
        var arr = o.children;
        for (var i = 0,
            l = this.children.length; i < l; i++) {
          var clone = this.children[i].clone(true);
          clone.parent = o;
          arr.push(clone);
        }
      };
      p._getObjectsUnderPoint = function(x, y, arr, mouse, activeListener, currentDepth) {
        currentDepth = currentDepth || 0;
        if (!currentDepth && !this._testMask(this, x, y)) {
          return null;
        }
        var mtx,
            ctx = createjs.DisplayObject._hitTestContext;
        activeListener = activeListener || (mouse && this._hasMouseEventListener());
        var children = this.children,
            l = children.length;
        for (var i = l - 1; i >= 0; i--) {
          var child = children[i];
          var hitArea = child.hitArea;
          if (!child.visible || (!hitArea && !child.isVisible()) || (mouse && !child.mouseEnabled)) {
            continue;
          }
          if (!hitArea && !this._testMask(child, x, y)) {
            continue;
          }
          if (!hitArea && child instanceof Container) {
            var result = child._getObjectsUnderPoint(x, y, arr, mouse, activeListener, currentDepth + 1);
            if (!arr && result) {
              return (mouse && !this.mouseChildren) ? this : result;
            }
          } else {
            if (mouse && !activeListener && !child._hasMouseEventListener()) {
              continue;
            }
            var props = child.getConcatenatedDisplayProps(child._props);
            mtx = props.matrix;
            if (hitArea) {
              mtx.appendMatrix(hitArea.getMatrix(hitArea._props.matrix));
              props.alpha = hitArea.alpha;
            }
            ctx.globalAlpha = props.alpha;
            ctx.setTransform(mtx.a, mtx.b, mtx.c, mtx.d, mtx.tx - x, mtx.ty - y);
            (hitArea || child).draw(ctx);
            if (!this._testHit(ctx)) {
              continue;
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, 2, 2);
            if (arr) {
              arr.push(child);
            } else {
              return (mouse && !this.mouseChildren) ? this : child;
            }
          }
        }
        return null;
      };
      p._testMask = function(target, x, y) {
        var mask = target.mask;
        if (!mask || !mask.graphics || mask.graphics.isEmpty()) {
          return true;
        }
        var mtx = this._props.matrix,
            parent = target.parent;
        mtx = parent ? parent.getConcatenatedMatrix(mtx) : mtx.identity();
        mtx = mask.getMatrix(mask._props.matrix).prependMatrix(mtx);
        var ctx = createjs.DisplayObject._hitTestContext;
        ctx.setTransform(mtx.a, mtx.b, mtx.c, mtx.d, mtx.tx - x, mtx.ty - y);
        mask.graphics.drawAsPath(ctx);
        ctx.fillStyle = "#000";
        ctx.fill();
        if (!this._testHit(ctx)) {
          return false;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, 2, 2);
        return true;
      };
      p._getBounds = function(matrix, ignoreTransform) {
        var bounds = this.DisplayObject_getBounds();
        if (bounds) {
          return this._transformBounds(bounds, matrix, ignoreTransform);
        }
        var mtx = this._props.matrix;
        mtx = ignoreTransform ? mtx.identity() : this.getMatrix(mtx);
        if (matrix) {
          mtx.prependMatrix(matrix);
        }
        var l = this.children.length,
            rect = null;
        for (var i = 0; i < l; i++) {
          var child = this.children[i];
          if (!child.visible || !(bounds = child._getBounds(mtx))) {
            continue;
          }
          if (rect) {
            rect.extend(bounds.x, bounds.y, bounds.width, bounds.height);
          } else {
            rect = bounds.clone();
          }
        }
        return rect;
      };
      createjs.Container = createjs.promote(Container, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Stage(canvas) {
        this.Container_constructor();
        this.autoClear = true;
        this.canvas = (typeof canvas == "string") ? document.getElementById(canvas) : canvas;
        this.mouseX = 0;
        this.mouseY = 0;
        this.drawRect = null;
        this.snapToPixelEnabled = false;
        this.mouseInBounds = false;
        this.tickOnUpdate = true;
        this.mouseMoveOutside = false;
        this.preventSelection = true;
        this._pointerData = {};
        this._pointerCount = 0;
        this._primaryPointerID = null;
        this._mouseOverIntervalID = null;
        this._nextStage = null;
        this._prevStage = null;
        this.enableDOMEvents(true);
      }
      var p = createjs.extend(Stage, createjs.Container);
      p._get_nextStage = function() {
        return this._nextStage;
      };
      p._set_nextStage = function(value) {
        if (this._nextStage) {
          this._nextStage._prevStage = null;
        }
        if (value) {
          value._prevStage = this;
        }
        this._nextStage = value;
      };
      try {
        Object.defineProperties(p, {nextStage: {
            get: p._get_nextStage,
            set: p._set_nextStage
          }});
      } catch (e) {}
      p.update = function(props) {
        if (!this.canvas) {
          return;
        }
        if (this.tickOnUpdate) {
          this.tick(props);
        }
        if (this.dispatchEvent("drawstart", false, true) === false) {
          return;
        }
        createjs.DisplayObject._snapToPixelEnabled = this.snapToPixelEnabled;
        var r = this.drawRect,
            ctx = this.canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (this.autoClear) {
          if (r) {
            ctx.clearRect(r.x, r.y, r.width, r.height);
          } else {
            ctx.clearRect(0, 0, this.canvas.width + 1, this.canvas.height + 1);
          }
        }
        ctx.save();
        if (this.drawRect) {
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.width, r.height);
          ctx.clip();
        }
        this.updateContext(ctx);
        this.draw(ctx, false);
        ctx.restore();
        this.dispatchEvent("drawend");
      };
      p.tick = function(props) {
        if (!this.tickEnabled || this.dispatchEvent("tickstart", false, true) === false) {
          return;
        }
        var evtObj = new createjs.Event("tick");
        if (props) {
          for (var n in props) {
            if (props.hasOwnProperty(n)) {
              evtObj[n] = props[n];
            }
          }
        }
        this._tick(evtObj);
        this.dispatchEvent("tickend");
      };
      p.handleEvent = function(evt) {
        if (evt.type == "tick") {
          this.update(evt);
        }
      };
      p.clear = function() {
        if (!this.canvas) {
          return;
        }
        var ctx = this.canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width + 1, this.canvas.height + 1);
      };
      p.toDataURL = function(backgroundColor, mimeType) {
        var data,
            ctx = this.canvas.getContext('2d'),
            w = this.canvas.width,
            h = this.canvas.height;
        if (backgroundColor) {
          data = ctx.getImageData(0, 0, w, h);
          var compositeOperation = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = backgroundColor;
          ctx.fillRect(0, 0, w, h);
        }
        var dataURL = this.canvas.toDataURL(mimeType || "image/png");
        if (backgroundColor) {
          ctx.putImageData(data, 0, 0);
          ctx.globalCompositeOperation = compositeOperation;
        }
        return dataURL;
      };
      p.enableMouseOver = function(frequency) {
        if (this._mouseOverIntervalID) {
          clearInterval(this._mouseOverIntervalID);
          this._mouseOverIntervalID = null;
          if (frequency == 0) {
            this._testMouseOver(true);
          }
        }
        if (frequency == null) {
          frequency = 20;
        } else if (frequency <= 0) {
          return;
        }
        var o = this;
        this._mouseOverIntervalID = setInterval(function() {
          o._testMouseOver();
        }, 1000 / Math.min(50, frequency));
      };
      p.enableDOMEvents = function(enable) {
        if (enable == null) {
          enable = true;
        }
        var n,
            o,
            ls = this._eventListeners;
        if (!enable && ls) {
          for (n in ls) {
            o = ls[n];
            o.t.removeEventListener(n, o.f, false);
          }
          this._eventListeners = null;
        } else if (enable && !ls && this.canvas) {
          var t = window.addEventListener ? window : document;
          var _this = this;
          ls = this._eventListeners = {};
          ls["mouseup"] = {
            t: t,
            f: function(e) {
              _this._handleMouseUp(e);
            }
          };
          ls["mousemove"] = {
            t: t,
            f: function(e) {
              _this._handleMouseMove(e);
            }
          };
          ls["dblclick"] = {
            t: this.canvas,
            f: function(e) {
              _this._handleDoubleClick(e);
            }
          };
          ls["mousedown"] = {
            t: this.canvas,
            f: function(e) {
              _this._handleMouseDown(e);
            }
          };
          for (n in ls) {
            o = ls[n];
            o.t.addEventListener(n, o.f, false);
          }
        }
      };
      p.clone = function() {
        throw ("Stage cannot be cloned.");
      };
      p.toString = function() {
        return "[Stage (name=" + this.name + ")]";
      };
      p._getElementRect = function(e) {
        var bounds;
        try {
          bounds = e.getBoundingClientRect();
        } catch (err) {
          bounds = {
            top: e.offsetTop,
            left: e.offsetLeft,
            width: e.offsetWidth,
            height: e.offsetHeight
          };
        }
        var offX = (window.pageXOffset || document.scrollLeft || 0) - (document.clientLeft || document.body.clientLeft || 0);
        var offY = (window.pageYOffset || document.scrollTop || 0) - (document.clientTop || document.body.clientTop || 0);
        var styles = window.getComputedStyle ? getComputedStyle(e, null) : e.currentStyle;
        var padL = parseInt(styles.paddingLeft) + parseInt(styles.borderLeftWidth);
        var padT = parseInt(styles.paddingTop) + parseInt(styles.borderTopWidth);
        var padR = parseInt(styles.paddingRight) + parseInt(styles.borderRightWidth);
        var padB = parseInt(styles.paddingBottom) + parseInt(styles.borderBottomWidth);
        return {
          left: bounds.left + offX + padL,
          right: bounds.right + offX - padR,
          top: bounds.top + offY + padT,
          bottom: bounds.bottom + offY - padB
        };
      };
      p._getPointerData = function(id) {
        var data = this._pointerData[id];
        if (!data) {
          data = this._pointerData[id] = {
            x: 0,
            y: 0
          };
        }
        return data;
      };
      p._handleMouseMove = function(e) {
        if (!e) {
          e = window.event;
        }
        this._handlePointerMove(-1, e, e.pageX, e.pageY);
      };
      p._handlePointerMove = function(id, e, pageX, pageY, owner) {
        if (this._prevStage && owner === undefined) {
          return;
        }
        if (!this.canvas) {
          return;
        }
        var nextStage = this._nextStage,
            o = this._getPointerData(id);
        var inBounds = o.inBounds;
        this._updatePointerPosition(id, e, pageX, pageY);
        if (inBounds || o.inBounds || this.mouseMoveOutside) {
          if (id === -1 && o.inBounds == !inBounds) {
            this._dispatchMouseEvent(this, (inBounds ? "mouseleave" : "mouseenter"), false, id, o, e);
          }
          this._dispatchMouseEvent(this, "stagemousemove", false, id, o, e);
          this._dispatchMouseEvent(o.target, "pressmove", true, id, o, e);
        }
        nextStage && nextStage._handlePointerMove(id, e, pageX, pageY, null);
      };
      p._updatePointerPosition = function(id, e, pageX, pageY) {
        var rect = this._getElementRect(this.canvas);
        pageX -= rect.left;
        pageY -= rect.top;
        var w = this.canvas.width;
        var h = this.canvas.height;
        pageX /= (rect.right - rect.left) / w;
        pageY /= (rect.bottom - rect.top) / h;
        var o = this._getPointerData(id);
        if (o.inBounds = (pageX >= 0 && pageY >= 0 && pageX <= w - 1 && pageY <= h - 1)) {
          o.x = pageX;
          o.y = pageY;
        } else if (this.mouseMoveOutside) {
          o.x = pageX < 0 ? 0 : (pageX > w - 1 ? w - 1 : pageX);
          o.y = pageY < 0 ? 0 : (pageY > h - 1 ? h - 1 : pageY);
        }
        o.posEvtObj = e;
        o.rawX = pageX;
        o.rawY = pageY;
        if (id === this._primaryPointerID || id === -1) {
          this.mouseX = o.x;
          this.mouseY = o.y;
          this.mouseInBounds = o.inBounds;
        }
      };
      p._handleMouseUp = function(e) {
        this._handlePointerUp(-1, e, false);
      };
      p._handlePointerUp = function(id, e, clear, owner) {
        var nextStage = this._nextStage,
            o = this._getPointerData(id);
        if (this._prevStage && owner === undefined) {
          return;
        }
        var target = null,
            oTarget = o.target;
        if (!owner && (oTarget || nextStage)) {
          target = this._getObjectsUnderPoint(o.x, o.y, null, true);
        }
        if (o.down) {
          this._dispatchMouseEvent(this, "stagemouseup", false, id, o, e, target);
          o.down = false;
        }
        if (target == oTarget) {
          this._dispatchMouseEvent(oTarget, "click", true, id, o, e);
        }
        this._dispatchMouseEvent(oTarget, "pressup", true, id, o, e);
        if (clear) {
          if (id == this._primaryPointerID) {
            this._primaryPointerID = null;
          }
          delete(this._pointerData[id]);
        } else {
          o.target = null;
        }
        nextStage && nextStage._handlePointerUp(id, e, clear, owner || target && this);
      };
      p._handleMouseDown = function(e) {
        this._handlePointerDown(-1, e, e.pageX, e.pageY);
      };
      p._handlePointerDown = function(id, e, pageX, pageY, owner) {
        if (this.preventSelection) {
          e.preventDefault();
        }
        if (this._primaryPointerID == null || id === -1) {
          this._primaryPointerID = id;
        }
        if (pageY != null) {
          this._updatePointerPosition(id, e, pageX, pageY);
        }
        var target = null,
            nextStage = this._nextStage,
            o = this._getPointerData(id);
        if (!owner) {
          target = o.target = this._getObjectsUnderPoint(o.x, o.y, null, true);
        }
        if (o.inBounds) {
          this._dispatchMouseEvent(this, "stagemousedown", false, id, o, e, target);
          o.down = true;
        }
        this._dispatchMouseEvent(target, "mousedown", true, id, o, e);
        nextStage && nextStage._handlePointerDown(id, e, pageX, pageY, owner || target && this);
      };
      p._testMouseOver = function(clear, owner, eventTarget) {
        if (this._prevStage && owner === undefined) {
          return;
        }
        var nextStage = this._nextStage;
        if (!this._mouseOverIntervalID) {
          nextStage && nextStage._testMouseOver(clear, owner, eventTarget);
          return;
        }
        var o = this._getPointerData(-1);
        if (!o || (!clear && this.mouseX == this._mouseOverX && this.mouseY == this._mouseOverY && this.mouseInBounds)) {
          return;
        }
        var e = o.posEvtObj;
        var isEventTarget = eventTarget || e && (e.target == this.canvas);
        var target = null,
            common = -1,
            cursor = "",
            t,
            i,
            l;
        if (!owner && (clear || this.mouseInBounds && isEventTarget)) {
          target = this._getObjectsUnderPoint(this.mouseX, this.mouseY, null, true);
          this._mouseOverX = this.mouseX;
          this._mouseOverY = this.mouseY;
        }
        var oldList = this._mouseOverTarget || [];
        var oldTarget = oldList[oldList.length - 1];
        var list = this._mouseOverTarget = [];
        t = target;
        while (t) {
          list.unshift(t);
          if (!cursor) {
            cursor = t.cursor;
          }
          t = t.parent;
        }
        this.canvas.style.cursor = cursor;
        if (!owner && eventTarget) {
          eventTarget.canvas.style.cursor = cursor;
        }
        for (i = 0, l = list.length; i < l; i++) {
          if (list[i] != oldList[i]) {
            break;
          }
          common = i;
        }
        if (oldTarget != target) {
          this._dispatchMouseEvent(oldTarget, "mouseout", true, -1, o, e, target);
        }
        for (i = oldList.length - 1; i > common; i--) {
          this._dispatchMouseEvent(oldList[i], "rollout", false, -1, o, e, target);
        }
        for (i = list.length - 1; i > common; i--) {
          this._dispatchMouseEvent(list[i], "rollover", false, -1, o, e, oldTarget);
        }
        if (oldTarget != target) {
          this._dispatchMouseEvent(target, "mouseover", true, -1, o, e, oldTarget);
        }
        nextStage && nextStage._testMouseOver(clear, owner || target && this, eventTarget || isEventTarget && this);
      };
      p._handleDoubleClick = function(e, owner) {
        var target = null,
            nextStage = this._nextStage,
            o = this._getPointerData(-1);
        if (!owner) {
          target = this._getObjectsUnderPoint(o.x, o.y, null, true);
          this._dispatchMouseEvent(target, "dblclick", true, -1, o, e);
        }
        nextStage && nextStage._handleDoubleClick(e, owner || target && this);
      };
      p._dispatchMouseEvent = function(target, type, bubbles, pointerId, o, nativeEvent, relatedTarget) {
        if (!target || (!bubbles && !target.hasEventListener(type))) {
          return;
        }
        var evt = new createjs.MouseEvent(type, bubbles, false, o.x, o.y, nativeEvent, pointerId, pointerId === this._primaryPointerID || pointerId === -1, o.rawX, o.rawY, relatedTarget);
        target.dispatchEvent(evt);
      };
      createjs.Stage = createjs.promote(Stage, "Container");
    }());
    this.createjs = this.createjs || {};
    (function() {
      function Bitmap(imageOrUri) {
        this.DisplayObject_constructor();
        if (typeof imageOrUri == "string") {
          this.image = document.createElement("img");
          this.image.src = imageOrUri;
        } else {
          this.image = imageOrUri;
        }
        this.sourceRect = null;
      }
      var p = createjs.extend(Bitmap, createjs.DisplayObject);
      p.initialize = Bitmap;
      p.isVisible = function() {
        var image = this.image;
        var hasContent = this.cacheCanvas || (image && (image.naturalWidth || image.getContext || image.readyState >= 2));
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0 && hasContent);
      };
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache) || !this.image) {
          return true;
        }
        var img = this.image,
            rect = this.sourceRect;
        if (rect) {
          var x1 = rect.x,
              y1 = rect.y,
              x2 = x1 + rect.width,
              y2 = y1 + rect.height,
              x = 0,
              y = 0,
              w = img.width,
              h = img.height;
          if (x1 < 0) {
            x -= x1;
            x1 = 0;
          }
          if (x2 > w) {
            x2 = w;
          }
          if (y1 < 0) {
            y -= y1;
            y1 = 0;
          }
          if (y2 > h) {
            y2 = h;
          }
          ctx.drawImage(img, x1, y1, x2 - x1, y2 - y1, x, y, x2 - x1, y2 - y1);
        } else {
          ctx.drawImage(img, 0, 0);
        }
        return true;
      };
      p.getBounds = function() {
        var rect = this.DisplayObject_getBounds();
        if (rect) {
          return rect;
        }
        var image = this.image,
            o = this.sourceRect || image;
        var hasContent = (image && (image.naturalWidth || image.getContext || image.readyState >= 2));
        return hasContent ? this._rectangle.setValues(0, 0, o.width, o.height) : null;
      };
      p.clone = function() {
        var o = new Bitmap(this.image);
        if (this.sourceRect) {
          o.sourceRect = this.sourceRect.clone();
        }
        this._cloneProps(o);
        return o;
      };
      p.toString = function() {
        return "[Bitmap (name=" + this.name + ")]";
      };
      createjs.Bitmap = createjs.promote(Bitmap, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Sprite(spriteSheet, frameOrAnimation) {
        this.DisplayObject_constructor();
        this.currentFrame = 0;
        this.currentAnimation = null;
        this.paused = true;
        this.spriteSheet = spriteSheet;
        this.currentAnimationFrame = 0;
        this.framerate = 0;
        this._animation = null;
        this._currentFrame = null;
        this._skipAdvance = false;
        if (frameOrAnimation != null) {
          this.gotoAndPlay(frameOrAnimation);
        }
      }
      var p = createjs.extend(Sprite, createjs.DisplayObject);
      p.initialize = Sprite;
      p.isVisible = function() {
        var hasContent = this.cacheCanvas || this.spriteSheet.complete;
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0 && hasContent);
      };
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache)) {
          return true;
        }
        this._normalizeFrame();
        var o = this.spriteSheet.getFrame(this._currentFrame | 0);
        if (!o) {
          return false;
        }
        var rect = o.rect;
        if (rect.width && rect.height) {
          ctx.drawImage(o.image, rect.x, rect.y, rect.width, rect.height, -o.regX, -o.regY, rect.width, rect.height);
        }
        return true;
      };
      p.play = function() {
        this.paused = false;
      };
      p.stop = function() {
        this.paused = true;
      };
      p.gotoAndPlay = function(frameOrAnimation) {
        this.paused = false;
        this._skipAdvance = true;
        this._goto(frameOrAnimation);
      };
      p.gotoAndStop = function(frameOrAnimation) {
        this.paused = true;
        this._goto(frameOrAnimation);
      };
      p.advance = function(time) {
        var fps = this.framerate || this.spriteSheet.framerate;
        var t = (fps && time != null) ? time / (1000 / fps) : 1;
        this._normalizeFrame(t);
      };
      p.getBounds = function() {
        return this.DisplayObject_getBounds() || this.spriteSheet.getFrameBounds(this.currentFrame, this._rectangle);
      };
      p.clone = function() {
        return this._cloneProps(new Sprite(this.spriteSheet));
      };
      p.toString = function() {
        return "[Sprite (name=" + this.name + ")]";
      };
      p._cloneProps = function(o) {
        this.DisplayObject__cloneProps(o);
        o.currentFrame = this.currentFrame;
        o.currentAnimation = this.currentAnimation;
        o.paused = this.paused;
        o.currentAnimationFrame = this.currentAnimationFrame;
        o.framerate = this.framerate;
        o._animation = this._animation;
        o._currentFrame = this._currentFrame;
        o._skipAdvance = this._skipAdvance;
        return o;
      };
      p._tick = function(evtObj) {
        if (!this.paused) {
          if (!this._skipAdvance) {
            this.advance(evtObj && evtObj.delta);
          }
          this._skipAdvance = false;
        }
        this.DisplayObject__tick(evtObj);
      };
      p._normalizeFrame = function(frameDelta) {
        frameDelta = frameDelta || 0;
        var animation = this._animation;
        var paused = this.paused;
        var frame = this._currentFrame;
        var l;
        if (animation) {
          var speed = animation.speed || 1;
          var animFrame = this.currentAnimationFrame;
          l = animation.frames.length;
          if (animFrame + frameDelta * speed >= l) {
            var next = animation.next;
            if (this._dispatchAnimationEnd(animation, frame, paused, next, l - 1)) {
              return;
            } else if (next) {
              return this._goto(next, frameDelta - (l - animFrame) / speed);
            } else {
              this.paused = true;
              animFrame = animation.frames.length - 1;
            }
          } else {
            animFrame += frameDelta * speed;
          }
          this.currentAnimationFrame = animFrame;
          this._currentFrame = animation.frames[animFrame | 0];
        } else {
          frame = (this._currentFrame += frameDelta);
          l = this.spriteSheet.getNumFrames();
          if (frame >= l && l > 0) {
            if (!this._dispatchAnimationEnd(animation, frame, paused, l - 1)) {
              if ((this._currentFrame -= l) >= l) {
                return this._normalizeFrame();
              }
            }
          }
        }
        frame = this._currentFrame | 0;
        if (this.currentFrame != frame) {
          this.currentFrame = frame;
          this.dispatchEvent("change");
        }
      };
      p._dispatchAnimationEnd = function(animation, frame, paused, next, end) {
        var name = animation ? animation.name : null;
        if (this.hasEventListener("animationend")) {
          var evt = new createjs.Event("animationend");
          evt.name = name;
          evt.next = next;
          this.dispatchEvent(evt);
        }
        var changed = (this._animation != animation || this._currentFrame != frame);
        if (!changed && !paused && this.paused) {
          this.currentAnimationFrame = end;
          changed = true;
        }
        return changed;
      };
      p._goto = function(frameOrAnimation, frame) {
        this.currentAnimationFrame = 0;
        if (isNaN(frameOrAnimation)) {
          var data = this.spriteSheet.getAnimation(frameOrAnimation);
          if (data) {
            this._animation = data;
            this.currentAnimation = frameOrAnimation;
            this._normalizeFrame(frame);
          }
        } else {
          this.currentAnimation = this._animation = null;
          this._currentFrame = frameOrAnimation;
          this._normalizeFrame();
        }
      };
      createjs.Sprite = createjs.promote(Sprite, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Shape(graphics) {
        this.DisplayObject_constructor();
        this.graphics = graphics ? graphics : new createjs.Graphics();
      }
      var p = createjs.extend(Shape, createjs.DisplayObject);
      p.isVisible = function() {
        var hasContent = this.cacheCanvas || (this.graphics && !this.graphics.isEmpty());
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0 && hasContent);
      };
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache)) {
          return true;
        }
        this.graphics.draw(ctx, this);
        return true;
      };
      p.clone = function(recursive) {
        var g = (recursive && this.graphics) ? this.graphics.clone() : this.graphics;
        return this._cloneProps(new Shape(g));
      };
      p.toString = function() {
        return "[Shape (name=" + this.name + ")]";
      };
      createjs.Shape = createjs.promote(Shape, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Text(text, font, color) {
        this.DisplayObject_constructor();
        this.text = text;
        this.font = font;
        this.color = color;
        this.textAlign = "left";
        this.textBaseline = "top";
        this.maxWidth = null;
        this.outline = 0;
        this.lineHeight = 0;
        this.lineWidth = null;
      }
      var p = createjs.extend(Text, createjs.DisplayObject);
      var canvas = (createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas"));
      if (canvas.getContext) {
        Text._workingContext = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
      }
      Text.H_OFFSETS = {
        start: 0,
        left: 0,
        center: -0.5,
        end: -1,
        right: -1
      };
      Text.V_OFFSETS = {
        top: 0,
        hanging: -0.01,
        middle: -0.4,
        alphabetic: -0.8,
        ideographic: -0.85,
        bottom: -1
      };
      p.isVisible = function() {
        var hasContent = this.cacheCanvas || (this.text != null && this.text !== "");
        return !!(this.visible && this.alpha > 0 && this.scaleX != 0 && this.scaleY != 0 && hasContent);
      };
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache)) {
          return true;
        }
        var col = this.color || "#000";
        if (this.outline) {
          ctx.strokeStyle = col;
          ctx.lineWidth = this.outline * 1;
        } else {
          ctx.fillStyle = col;
        }
        this._drawText(this._prepContext(ctx));
        return true;
      };
      p.getMeasuredWidth = function() {
        return this._getMeasuredWidth(this.text);
      };
      p.getMeasuredLineHeight = function() {
        return this._getMeasuredWidth("M") * 1.2;
      };
      p.getMeasuredHeight = function() {
        return this._drawText(null, {}).height;
      };
      p.getBounds = function() {
        var rect = this.DisplayObject_getBounds();
        if (rect) {
          return rect;
        }
        if (this.text == null || this.text === "") {
          return null;
        }
        var o = this._drawText(null, {});
        var w = (this.maxWidth && this.maxWidth < o.width) ? this.maxWidth : o.width;
        var x = w * Text.H_OFFSETS[this.textAlign || "left"];
        var lineHeight = this.lineHeight || this.getMeasuredLineHeight();
        var y = lineHeight * Text.V_OFFSETS[this.textBaseline || "top"];
        return this._rectangle.setValues(x, y, w, o.height);
      };
      p.getMetrics = function() {
        var o = {lines: []};
        o.lineHeight = this.lineHeight || this.getMeasuredLineHeight();
        o.vOffset = o.lineHeight * Text.V_OFFSETS[this.textBaseline || "top"];
        return this._drawText(null, o, o.lines);
      };
      p.clone = function() {
        return this._cloneProps(new Text(this.text, this.font, this.color));
      };
      p.toString = function() {
        return "[Text (text=" + (this.text.length > 20 ? this.text.substr(0, 17) + "..." : this.text) + ")]";
      };
      p._cloneProps = function(o) {
        this.DisplayObject__cloneProps(o);
        o.textAlign = this.textAlign;
        o.textBaseline = this.textBaseline;
        o.maxWidth = this.maxWidth;
        o.outline = this.outline;
        o.lineHeight = this.lineHeight;
        o.lineWidth = this.lineWidth;
        return o;
      };
      p._prepContext = function(ctx) {
        ctx.font = this.font || "10px sans-serif";
        ctx.textAlign = this.textAlign || "left";
        ctx.textBaseline = this.textBaseline || "top";
        return ctx;
      };
      p._drawText = function(ctx, o, lines) {
        var paint = !!ctx;
        if (!paint) {
          ctx = Text._workingContext;
          ctx.save();
          this._prepContext(ctx);
        }
        var lineHeight = this.lineHeight || this.getMeasuredLineHeight();
        var maxW = 0,
            count = 0;
        var hardLines = String(this.text).split(/(?:\r\n|\r|\n)/);
        for (var i = 0,
            l = hardLines.length; i < l; i++) {
          var str = hardLines[i];
          var w = null;
          if (this.lineWidth != null && (w = ctx.measureText(str).width) > this.lineWidth) {
            var words = str.split(/(\s)/);
            str = words[0];
            w = ctx.measureText(str).width;
            for (var j = 1,
                jl = words.length; j < jl; j += 2) {
              var wordW = ctx.measureText(words[j] + words[j + 1]).width;
              if (w + wordW > this.lineWidth) {
                if (paint) {
                  this._drawTextLine(ctx, str, count * lineHeight);
                }
                if (lines) {
                  lines.push(str);
                }
                if (w > maxW) {
                  maxW = w;
                }
                str = words[j + 1];
                w = ctx.measureText(str).width;
                count++;
              } else {
                str += words[j] + words[j + 1];
                w += wordW;
              }
            }
          }
          if (paint) {
            this._drawTextLine(ctx, str, count * lineHeight);
          }
          if (lines) {
            lines.push(str);
          }
          if (o && w == null) {
            w = ctx.measureText(str).width;
          }
          if (w > maxW) {
            maxW = w;
          }
          count++;
        }
        if (o) {
          o.width = maxW;
          o.height = count * lineHeight;
        }
        if (!paint) {
          ctx.restore();
        }
        return o;
      };
      p._drawTextLine = function(ctx, text, y) {
        if (this.outline) {
          ctx.strokeText(text, 0, y, this.maxWidth || 0xFFFF);
        } else {
          ctx.fillText(text, 0, y, this.maxWidth || 0xFFFF);
        }
      };
      p._getMeasuredWidth = function(text) {
        var ctx = Text._workingContext;
        ctx.save();
        var w = this._prepContext(ctx).measureText(text).width;
        ctx.restore();
        return w;
      };
      createjs.Text = createjs.promote(Text, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function BitmapText(text, spriteSheet) {
        this.Container_constructor();
        this.text = text || "";
        this.spriteSheet = spriteSheet;
        this.lineHeight = 0;
        this.letterSpacing = 0;
        this.spaceWidth = 0;
        this._oldProps = {
          text: 0,
          spriteSheet: 0,
          lineHeight: 0,
          letterSpacing: 0,
          spaceWidth: 0
        };
      }
      var p = createjs.extend(BitmapText, createjs.Container);
      BitmapText.maxPoolSize = 100;
      BitmapText._spritePool = [];
      p.draw = function(ctx, ignoreCache) {
        if (this.DisplayObject_draw(ctx, ignoreCache)) {
          return;
        }
        this._updateText();
        this.Container_draw(ctx, ignoreCache);
      };
      p.getBounds = function() {
        this._updateText();
        return this.Container_getBounds();
      };
      p.isVisible = function() {
        var hasContent = this.cacheCanvas || (this.spriteSheet && this.spriteSheet.complete && this.text);
        return !!(this.visible && this.alpha > 0 && this.scaleX !== 0 && this.scaleY !== 0 && hasContent);
      };
      p.clone = function() {
        return this._cloneProps(new BitmapText(this.text, this.spriteSheet));
      };
      p.addChild = p.addChildAt = p.removeChild = p.removeChildAt = p.removeAllChildren = function() {};
      p._cloneProps = function(o) {
        this.Container__cloneProps(o);
        o.lineHeight = this.lineHeight;
        o.letterSpacing = this.letterSpacing;
        o.spaceWidth = this.spaceWidth;
        return o;
      };
      p._getFrameIndex = function(character, spriteSheet) {
        var c,
            o = spriteSheet.getAnimation(character);
        if (!o) {
          (character != (c = character.toUpperCase())) || (character != (c = character.toLowerCase())) || (c = null);
          if (c) {
            o = spriteSheet.getAnimation(c);
          }
        }
        return o && o.frames[0];
      };
      p._getFrame = function(character, spriteSheet) {
        var index = this._getFrameIndex(character, spriteSheet);
        return index == null ? index : spriteSheet.getFrame(index);
      };
      p._getLineHeight = function(ss) {
        var frame = this._getFrame("1", ss) || this._getFrame("T", ss) || this._getFrame("L", ss) || ss.getFrame(0);
        return frame ? frame.rect.height : 1;
      };
      p._getSpaceWidth = function(ss) {
        var frame = this._getFrame("1", ss) || this._getFrame("l", ss) || this._getFrame("e", ss) || this._getFrame("a", ss) || ss.getFrame(0);
        return frame ? frame.rect.width : 1;
      };
      p._updateText = function() {
        var x = 0,
            y = 0,
            o = this._oldProps,
            change = false,
            spaceW = this.spaceWidth,
            lineH = this.lineHeight,
            ss = this.spriteSheet;
        var pool = BitmapText._spritePool,
            kids = this.children,
            childIndex = 0,
            numKids = kids.length,
            sprite;
        for (var n in o) {
          if (o[n] != this[n]) {
            o[n] = this[n];
            change = true;
          }
        }
        if (!change) {
          return;
        }
        var hasSpace = !!this._getFrame(" ", ss);
        if (!hasSpace && !spaceW) {
          spaceW = this._getSpaceWidth(ss);
        }
        if (!lineH) {
          lineH = this._getLineHeight(ss);
        }
        for (var i = 0,
            l = this.text.length; i < l; i++) {
          var character = this.text.charAt(i);
          if (character == " " && !hasSpace) {
            x += spaceW;
            continue;
          } else if (character == "\n" || character == "\r") {
            if (character == "\r" && this.text.charAt(i + 1) == "\n") {
              i++;
            }
            x = 0;
            y += lineH;
            continue;
          }
          var index = this._getFrameIndex(character, ss);
          if (index == null) {
            continue;
          }
          if (childIndex < numKids) {
            sprite = kids[childIndex];
          } else {
            kids.push(sprite = pool.length ? pool.pop() : new createjs.Sprite());
            sprite.parent = this;
            numKids++;
          }
          sprite.spriteSheet = ss;
          sprite.gotoAndStop(index);
          sprite.x = x;
          sprite.y = y;
          childIndex++;
          x += sprite.getBounds().width + this.letterSpacing;
        }
        while (numKids > childIndex) {
          pool.push(sprite = kids.pop());
          sprite.parent = null;
          numKids--;
        }
        if (pool.length > BitmapText.maxPoolSize) {
          pool.length = BitmapText.maxPoolSize;
        }
      };
      createjs.BitmapText = createjs.promote(BitmapText, "Container");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function SpriteSheetUtils() {
        throw "SpriteSheetUtils cannot be instantiated";
      }
      var canvas = (createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas"));
      if (canvas.getContext) {
        SpriteSheetUtils._workingCanvas = canvas;
        SpriteSheetUtils._workingContext = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
      }
      SpriteSheetUtils.addFlippedFrames = function(spriteSheet, horizontal, vertical, both) {
        if (!horizontal && !vertical && !both) {
          return;
        }
        var count = 0;
        if (horizontal) {
          SpriteSheetUtils._flip(spriteSheet, ++count, true, false);
        }
        if (vertical) {
          SpriteSheetUtils._flip(spriteSheet, ++count, false, true);
        }
        if (both) {
          SpriteSheetUtils._flip(spriteSheet, ++count, true, true);
        }
      };
      SpriteSheetUtils.extractFrame = function(spriteSheet, frameOrAnimation) {
        if (isNaN(frameOrAnimation)) {
          frameOrAnimation = spriteSheet.getAnimation(frameOrAnimation).frames[0];
        }
        var data = spriteSheet.getFrame(frameOrAnimation);
        if (!data) {
          return null;
        }
        var r = data.rect;
        var canvas = SpriteSheetUtils._workingCanvas;
        canvas.width = r.width;
        canvas.height = r.height;
        SpriteSheetUtils._workingContext.drawImage(data.image, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        var img = document.createElement("img");
        img.src = canvas.toDataURL("image/png");
        return img;
      };
      SpriteSheetUtils.mergeAlpha = function(rgbImage, alphaImage, canvas) {
        if (!canvas) {
          canvas = createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas");
        }
        canvas.width = Math.max(alphaImage.width, rgbImage.width);
        canvas.height = Math.max(alphaImage.height, rgbImage.height);
        var ctx = canvas.getContext("2d");
        ctx.save();
        ctx.drawImage(rgbImage, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(alphaImage, 0, 0);
        ctx.restore();
        return canvas;
      };
      SpriteSheetUtils._flip = function(spriteSheet, count, h, v) {
        var imgs = spriteSheet._images;
        var canvas = SpriteSheetUtils._workingCanvas;
        var ctx = SpriteSheetUtils._workingContext;
        var il = imgs.length / count;
        for (var i = 0; i < il; i++) {
          var src = imgs[i];
          src.__tmp = i;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width + 1, canvas.height + 1);
          canvas.width = src.width;
          canvas.height = src.height;
          ctx.setTransform(h ? -1 : 1, 0, 0, v ? -1 : 1, h ? src.width : 0, v ? src.height : 0);
          ctx.drawImage(src, 0, 0);
          var img = document.createElement("img");
          img.src = canvas.toDataURL("image/png");
          img.width = src.width;
          img.height = src.height;
          imgs.push(img);
        }
        var frames = spriteSheet._frames;
        var fl = frames.length / count;
        for (i = 0; i < fl; i++) {
          src = frames[i];
          var rect = src.rect.clone();
          img = imgs[src.image.__tmp + il * count];
          var frame = {
            image: img,
            rect: rect,
            regX: src.regX,
            regY: src.regY
          };
          if (h) {
            rect.x = img.width - rect.x - rect.width;
            frame.regX = rect.width - src.regX;
          }
          if (v) {
            rect.y = img.height - rect.y - rect.height;
            frame.regY = rect.height - src.regY;
          }
          frames.push(frame);
        }
        var sfx = "_" + (h ? "h" : "") + (v ? "v" : "");
        var names = spriteSheet._animations;
        var data = spriteSheet._data;
        var al = names.length / count;
        for (i = 0; i < al; i++) {
          var name = names[i];
          src = data[name];
          var anim = {
            name: name + sfx,
            speed: src.speed,
            next: src.next,
            frames: []
          };
          if (src.next) {
            anim.next += sfx;
          }
          frames = src.frames;
          for (var j = 0,
              l = frames.length; j < l; j++) {
            anim.frames.push(frames[j] + fl * count);
          }
          data[anim.name] = anim;
          names.push(anim.name);
        }
      };
      createjs.SpriteSheetUtils = SpriteSheetUtils;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function SpriteSheetBuilder() {
        this.EventDispatcher_constructor();
        this.maxWidth = 2048;
        this.maxHeight = 2048;
        this.spriteSheet = null;
        this.scale = 1;
        this.padding = 1;
        this.timeSlice = 0.3;
        this.progress = -1;
        this._frames = [];
        this._animations = {};
        this._data = null;
        this._nextFrameIndex = 0;
        this._index = 0;
        this._timerID = null;
        this._scale = 1;
      }
      var p = createjs.extend(SpriteSheetBuilder, createjs.EventDispatcher);
      SpriteSheetBuilder.ERR_DIMENSIONS = "frame dimensions exceed max spritesheet dimensions";
      SpriteSheetBuilder.ERR_RUNNING = "a build is already running";
      p.addFrame = function(source, sourceRect, scale, setupFunction, setupData) {
        if (this._data) {
          throw SpriteSheetBuilder.ERR_RUNNING;
        }
        var rect = sourceRect || source.bounds || source.nominalBounds;
        if (!rect && source.getBounds) {
          rect = source.getBounds();
        }
        if (!rect) {
          return null;
        }
        scale = scale || 1;
        return this._frames.push({
          source: source,
          sourceRect: rect,
          scale: scale,
          funct: setupFunction,
          data: setupData,
          index: this._frames.length,
          height: rect.height * scale
        }) - 1;
      };
      p.addAnimation = function(name, frames, next, frequency) {
        if (this._data) {
          throw SpriteSheetBuilder.ERR_RUNNING;
        }
        this._animations[name] = {
          frames: frames,
          next: next,
          frequency: frequency
        };
      };
      p.addMovieClip = function(source, sourceRect, scale, setupFunction, setupData, labelFunction) {
        if (this._data) {
          throw SpriteSheetBuilder.ERR_RUNNING;
        }
        var rects = source.frameBounds;
        var rect = sourceRect || source.bounds || source.nominalBounds;
        if (!rect && source.getBounds) {
          rect = source.getBounds();
        }
        if (!rect && !rects) {
          return;
        }
        var i,
            l,
            baseFrameIndex = this._frames.length;
        var duration = source.timeline.duration;
        for (i = 0; i < duration; i++) {
          var r = (rects && rects[i]) ? rects[i] : rect;
          this.addFrame(source, r, scale, this._setupMovieClipFrame, {
            i: i,
            f: setupFunction,
            d: setupData
          });
        }
        var labels = source.timeline._labels;
        var lbls = [];
        for (var n in labels) {
          lbls.push({
            index: labels[n],
            label: n
          });
        }
        if (lbls.length) {
          lbls.sort(function(a, b) {
            return a.index - b.index;
          });
          for (i = 0, l = lbls.length; i < l; i++) {
            var label = lbls[i].label;
            var start = baseFrameIndex + lbls[i].index;
            var end = baseFrameIndex + ((i == l - 1) ? duration : lbls[i + 1].index);
            var frames = [];
            for (var j = start; j < end; j++) {
              frames.push(j);
            }
            if (labelFunction) {
              label = labelFunction(label, source, start, end);
              if (!label) {
                continue;
              }
            }
            this.addAnimation(label, frames, true);
          }
        }
      };
      p.build = function() {
        if (this._data) {
          throw SpriteSheetBuilder.ERR_RUNNING;
        }
        this._startBuild();
        while (this._drawNext()) {}
        this._endBuild();
        return this.spriteSheet;
      };
      p.buildAsync = function(timeSlice) {
        if (this._data) {
          throw SpriteSheetBuilder.ERR_RUNNING;
        }
        this.timeSlice = timeSlice;
        this._startBuild();
        var _this = this;
        this._timerID = setTimeout(function() {
          _this._run();
        }, 50 - Math.max(0.01, Math.min(0.99, this.timeSlice || 0.3)) * 50);
      };
      p.stopAsync = function() {
        clearTimeout(this._timerID);
        this._data = null;
      };
      p.clone = function() {
        throw ("SpriteSheetBuilder cannot be cloned.");
      };
      p.toString = function() {
        return "[SpriteSheetBuilder]";
      };
      p._startBuild = function() {
        var pad = this.padding || 0;
        this.progress = 0;
        this.spriteSheet = null;
        this._index = 0;
        this._scale = this.scale;
        var dataFrames = [];
        this._data = {
          images: [],
          frames: dataFrames,
          animations: this._animations
        };
        var frames = this._frames.slice();
        frames.sort(function(a, b) {
          return (a.height <= b.height) ? -1 : 1;
        });
        if (frames[frames.length - 1].height + pad * 2 > this.maxHeight) {
          throw SpriteSheetBuilder.ERR_DIMENSIONS;
        }
        var y = 0,
            x = 0;
        var img = 0;
        while (frames.length) {
          var o = this._fillRow(frames, y, img, dataFrames, pad);
          if (o.w > x) {
            x = o.w;
          }
          y += o.h;
          if (!o.h || !frames.length) {
            var canvas = createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas");
            canvas.width = this._getSize(x, this.maxWidth);
            canvas.height = this._getSize(y, this.maxHeight);
            this._data.images[img] = canvas;
            if (!o.h) {
              x = y = 0;
              img++;
            }
          }
        }
      };
      p._setupMovieClipFrame = function(source, data) {
        var ae = source.actionsEnabled;
        source.actionsEnabled = false;
        source.gotoAndStop(data.i);
        source.actionsEnabled = ae;
        data.f && data.f(source, data.d, data.i);
      };
      p._getSize = function(size, max) {
        var pow = 4;
        while (Math.pow(2, ++pow) < size) {}
        return Math.min(max, Math.pow(2, pow));
      };
      p._fillRow = function(frames, y, img, dataFrames, pad) {
        var w = this.maxWidth;
        var maxH = this.maxHeight;
        y += pad;
        var h = maxH - y;
        var x = pad;
        var height = 0;
        for (var i = frames.length - 1; i >= 0; i--) {
          var frame = frames[i];
          var sc = this._scale * frame.scale;
          var rect = frame.sourceRect;
          var source = frame.source;
          var rx = Math.floor(sc * rect.x - pad);
          var ry = Math.floor(sc * rect.y - pad);
          var rh = Math.ceil(sc * rect.height + pad * 2);
          var rw = Math.ceil(sc * rect.width + pad * 2);
          if (rw > w) {
            throw SpriteSheetBuilder.ERR_DIMENSIONS;
          }
          if (rh > h || x + rw > w) {
            continue;
          }
          frame.img = img;
          frame.rect = new createjs.Rectangle(x, y, rw, rh);
          height = height || rh;
          frames.splice(i, 1);
          dataFrames[frame.index] = [x, y, rw, rh, img, Math.round(-rx + sc * source.regX - pad), Math.round(-ry + sc * source.regY - pad)];
          x += rw;
        }
        return {
          w: x,
          h: height
        };
      };
      p._endBuild = function() {
        this.spriteSheet = new createjs.SpriteSheet(this._data);
        this._data = null;
        this.progress = 1;
        this.dispatchEvent("complete");
      };
      p._run = function() {
        var ts = Math.max(0.01, Math.min(0.99, this.timeSlice || 0.3)) * 50;
        var t = (new Date()).getTime() + ts;
        var complete = false;
        while (t > (new Date()).getTime()) {
          if (!this._drawNext()) {
            complete = true;
            break;
          }
        }
        if (complete) {
          this._endBuild();
        } else {
          var _this = this;
          this._timerID = setTimeout(function() {
            _this._run();
          }, 50 - ts);
        }
        var p = this.progress = this._index / this._frames.length;
        if (this.hasEventListener("progress")) {
          var evt = new createjs.Event("progress");
          evt.progress = p;
          this.dispatchEvent(evt);
        }
      };
      p._drawNext = function() {
        var frame = this._frames[this._index];
        var sc = frame.scale * this._scale;
        var rect = frame.rect;
        var sourceRect = frame.sourceRect;
        var canvas = this._data.images[frame.img];
        var ctx = canvas.getContext("2d");
        frame.funct && frame.funct(frame.source, frame.data);
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.translate(Math.ceil(rect.x - sourceRect.x * sc), Math.ceil(rect.y - sourceRect.y * sc));
        ctx.scale(sc, sc);
        frame.source.draw(ctx);
        ctx.restore();
        return (++this._index) < this._frames.length;
      };
      createjs.SpriteSheetBuilder = createjs.promote(SpriteSheetBuilder, "EventDispatcher");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function DOMElement(htmlElement) {
        this.DisplayObject_constructor();
        if (typeof(htmlElement) == "string") {
          htmlElement = document.getElementById(htmlElement);
        }
        this.mouseEnabled = false;
        var style = htmlElement.style;
        style.position = "absolute";
        style.transformOrigin = style.WebkitTransformOrigin = style.msTransformOrigin = style.MozTransformOrigin = style.OTransformOrigin = "0% 0%";
        this.htmlElement = htmlElement;
        this._oldProps = null;
      }
      var p = createjs.extend(DOMElement, createjs.DisplayObject);
      p.isVisible = function() {
        return this.htmlElement != null;
      };
      p.draw = function(ctx, ignoreCache) {
        return true;
      };
      p.cache = function() {};
      p.uncache = function() {};
      p.updateCache = function() {};
      p.hitTest = function() {};
      p.localToGlobal = function() {};
      p.globalToLocal = function() {};
      p.localToLocal = function() {};
      p.clone = function() {
        throw ("DOMElement cannot be cloned.");
      };
      p.toString = function() {
        return "[DOMElement (name=" + this.name + ")]";
      };
      p._tick = function(evtObj) {
        var stage = this.getStage();
        stage && stage.on("drawend", this._handleDrawEnd, this, true);
        this.DisplayObject__tick(evtObj);
      };
      p._handleDrawEnd = function(evt) {
        var o = this.htmlElement;
        if (!o) {
          return;
        }
        var style = o.style;
        var props = this.getConcatenatedDisplayProps(this._props),
            mtx = props.matrix;
        var visibility = props.visible ? "visible" : "hidden";
        if (visibility != style.visibility) {
          style.visibility = visibility;
        }
        if (!props.visible) {
          return;
        }
        var oldProps = this._oldProps,
            oldMtx = oldProps && oldProps.matrix;
        var n = 10000;
        if (!oldMtx || !oldMtx.equals(mtx)) {
          var str = "matrix(" + (mtx.a * n | 0) / n + "," + (mtx.b * n | 0) / n + "," + (mtx.c * n | 0) / n + "," + (mtx.d * n | 0) / n + "," + (mtx.tx + 0.5 | 0);
          style.transform = style.WebkitTransform = style.OTransform = style.msTransform = str + "," + (mtx.ty + 0.5 | 0) + ")";
          style.MozTransform = str + "px," + (mtx.ty + 0.5 | 0) + "px)";
          if (!oldProps) {
            oldProps = this._oldProps = new createjs.DisplayProps(true, NaN);
          }
          oldProps.matrix.copy(mtx);
        }
        if (oldProps.alpha != props.alpha) {
          style.opacity = "" + (props.alpha * n | 0) / n;
          oldProps.alpha = props.alpha;
        }
      };
      createjs.DOMElement = createjs.promote(DOMElement, "DisplayObject");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Filter() {}
      var p = Filter.prototype;
      p.getBounds = function(rect) {
        return rect;
      };
      p.applyFilter = function(ctx, x, y, width, height, targetCtx, targetX, targetY) {
        targetCtx = targetCtx || ctx;
        if (targetX == null) {
          targetX = x;
        }
        if (targetY == null) {
          targetY = y;
        }
        try {
          var imageData = ctx.getImageData(x, y, width, height);
        } catch (e) {
          return false;
        }
        if (this._applyFilter(imageData)) {
          targetCtx.putImageData(imageData, targetX, targetY);
          return true;
        }
        return false;
      };
      p.toString = function() {
        return "[Filter]";
      };
      p.clone = function() {
        return new Filter();
      };
      p._applyFilter = function(imageData) {
        return true;
      };
      createjs.Filter = Filter;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function BlurFilter(blurX, blurY, quality) {
        if (isNaN(blurX) || blurX < 0)
          blurX = 0;
        if (isNaN(blurY) || blurY < 0)
          blurY = 0;
        if (isNaN(quality) || quality < 1)
          quality = 1;
        this.blurX = blurX | 0;
        this.blurY = blurY | 0;
        this.quality = quality | 0;
      }
      var p = createjs.extend(BlurFilter, createjs.Filter);
      BlurFilter.MUL_TABLE = [1, 171, 205, 293, 57, 373, 79, 137, 241, 27, 391, 357, 41, 19, 283, 265, 497, 469, 443, 421, 25, 191, 365, 349, 335, 161, 155, 149, 9, 278, 269, 261, 505, 245, 475, 231, 449, 437, 213, 415, 405, 395, 193, 377, 369, 361, 353, 345, 169, 331, 325, 319, 313, 307, 301, 37, 145, 285, 281, 69, 271, 267, 263, 259, 509, 501, 493, 243, 479, 118, 465, 459, 113, 446, 55, 435, 429, 423, 209, 413, 51, 403, 199, 393, 97, 3, 379, 375, 371, 367, 363, 359, 355, 351, 347, 43, 85, 337, 333, 165, 327, 323, 5, 317, 157, 311, 77, 305, 303, 75, 297, 294, 73, 289, 287, 71, 141, 279, 277, 275, 68, 135, 67, 133, 33, 262, 260, 129, 511, 507, 503, 499, 495, 491, 61, 121, 481, 477, 237, 235, 467, 232, 115, 457, 227, 451, 7, 445, 221, 439, 218, 433, 215, 427, 425, 211, 419, 417, 207, 411, 409, 203, 202, 401, 399, 396, 197, 49, 389, 387, 385, 383, 95, 189, 47, 187, 93, 185, 23, 183, 91, 181, 45, 179, 89, 177, 11, 175, 87, 173, 345, 343, 341, 339, 337, 21, 167, 83, 331, 329, 327, 163, 81, 323, 321, 319, 159, 79, 315, 313, 39, 155, 309, 307, 153, 305, 303, 151, 75, 299, 149, 37, 295, 147, 73, 291, 145, 289, 287, 143, 285, 71, 141, 281, 35, 279, 139, 69, 275, 137, 273, 17, 271, 135, 269, 267, 133, 265, 33, 263, 131, 261, 130, 259, 129, 257, 1];
      BlurFilter.SHG_TABLE = [0, 9, 10, 11, 9, 12, 10, 11, 12, 9, 13, 13, 10, 9, 13, 13, 14, 14, 14, 14, 10, 13, 14, 14, 14, 13, 13, 13, 9, 14, 14, 14, 15, 14, 15, 14, 15, 15, 14, 15, 15, 15, 14, 15, 15, 15, 15, 15, 14, 15, 15, 15, 15, 15, 15, 12, 14, 15, 15, 13, 15, 15, 15, 15, 16, 16, 16, 15, 16, 14, 16, 16, 14, 16, 13, 16, 16, 16, 15, 16, 13, 16, 15, 16, 14, 9, 16, 16, 16, 16, 16, 16, 16, 16, 16, 13, 14, 16, 16, 15, 16, 16, 10, 16, 15, 16, 14, 16, 16, 14, 16, 16, 14, 16, 16, 14, 15, 16, 16, 16, 14, 15, 14, 15, 13, 16, 16, 15, 17, 17, 17, 17, 17, 17, 14, 15, 17, 17, 16, 16, 17, 16, 15, 17, 16, 17, 11, 17, 16, 17, 16, 17, 16, 17, 17, 16, 17, 17, 16, 17, 17, 16, 16, 17, 17, 17, 16, 14, 17, 17, 17, 17, 15, 16, 14, 16, 15, 16, 13, 16, 15, 16, 14, 16, 15, 16, 12, 16, 15, 16, 17, 17, 17, 17, 17, 13, 16, 15, 17, 17, 17, 16, 15, 17, 17, 17, 16, 15, 17, 17, 14, 16, 17, 17, 16, 17, 17, 16, 15, 17, 16, 14, 17, 16, 15, 17, 16, 17, 17, 16, 17, 15, 16, 17, 14, 17, 16, 15, 17, 16, 17, 13, 17, 16, 17, 17, 16, 17, 14, 17, 16, 17, 16, 17, 16, 17, 9];
      p.getBounds = function(rect) {
        var x = this.blurX | 0,
            y = this.blurY | 0;
        if (x <= 0 && y <= 0) {
          return rect;
        }
        var q = Math.pow(this.quality, 0.2);
        return (rect || new createjs.Rectangle()).pad(x * q + 1, y * q + 1, x * q + 1, y * q + 1);
      };
      p.clone = function() {
        return new BlurFilter(this.blurX, this.blurY, this.quality);
      };
      p.toString = function() {
        return "[BlurFilter]";
      };
      p._applyFilter = function(imageData) {
        var radiusX = this.blurX >> 1;
        if (isNaN(radiusX) || radiusX < 0)
          return false;
        var radiusY = this.blurY >> 1;
        if (isNaN(radiusY) || radiusY < 0)
          return false;
        if (radiusX == 0 && radiusY == 0)
          return false;
        var iterations = this.quality;
        if (isNaN(iterations) || iterations < 1)
          iterations = 1;
        iterations |= 0;
        if (iterations > 3)
          iterations = 3;
        if (iterations < 1)
          iterations = 1;
        var px = imageData.data;
        var x = 0,
            y = 0,
            i = 0,
            p = 0,
            yp = 0,
            yi = 0,
            yw = 0,
            r = 0,
            g = 0,
            b = 0,
            a = 0,
            pr = 0,
            pg = 0,
            pb = 0,
            pa = 0;
        var divx = (radiusX + radiusX + 1) | 0;
        var divy = (radiusY + radiusY + 1) | 0;
        var w = imageData.width | 0;
        var h = imageData.height | 0;
        var w1 = (w - 1) | 0;
        var h1 = (h - 1) | 0;
        var rxp1 = (radiusX + 1) | 0;
        var ryp1 = (radiusY + 1) | 0;
        var ssx = {
          r: 0,
          b: 0,
          g: 0,
          a: 0
        };
        var sx = ssx;
        for (i = 1; i < divx; i++) {
          sx = sx.n = {
            r: 0,
            b: 0,
            g: 0,
            a: 0
          };
        }
        sx.n = ssx;
        var ssy = {
          r: 0,
          b: 0,
          g: 0,
          a: 0
        };
        var sy = ssy;
        for (i = 1; i < divy; i++) {
          sy = sy.n = {
            r: 0,
            b: 0,
            g: 0,
            a: 0
          };
        }
        sy.n = ssy;
        var si = null;
        var mtx = BlurFilter.MUL_TABLE[radiusX] | 0;
        var stx = BlurFilter.SHG_TABLE[radiusX] | 0;
        var mty = BlurFilter.MUL_TABLE[radiusY] | 0;
        var sty = BlurFilter.SHG_TABLE[radiusY] | 0;
        while (iterations-- > 0) {
          yw = yi = 0;
          var ms = mtx;
          var ss = stx;
          for (y = h; --y > -1; ) {
            r = rxp1 * (pr = px[(yi) | 0]);
            g = rxp1 * (pg = px[(yi + 1) | 0]);
            b = rxp1 * (pb = px[(yi + 2) | 0]);
            a = rxp1 * (pa = px[(yi + 3) | 0]);
            sx = ssx;
            for (i = rxp1; --i > -1; ) {
              sx.r = pr;
              sx.g = pg;
              sx.b = pb;
              sx.a = pa;
              sx = sx.n;
            }
            for (i = 1; i < rxp1; i++) {
              p = (yi + ((w1 < i ? w1 : i) << 2)) | 0;
              r += (sx.r = px[p]);
              g += (sx.g = px[p + 1]);
              b += (sx.b = px[p + 2]);
              a += (sx.a = px[p + 3]);
              sx = sx.n;
            }
            si = ssx;
            for (x = 0; x < w; x++) {
              px[yi++] = (r * ms) >>> ss;
              px[yi++] = (g * ms) >>> ss;
              px[yi++] = (b * ms) >>> ss;
              px[yi++] = (a * ms) >>> ss;
              p = ((yw + ((p = x + radiusX + 1) < w1 ? p : w1)) << 2);
              r -= si.r - (si.r = px[p]);
              g -= si.g - (si.g = px[p + 1]);
              b -= si.b - (si.b = px[p + 2]);
              a -= si.a - (si.a = px[p + 3]);
              si = si.n;
            }
            yw += w;
          }
          ms = mty;
          ss = sty;
          for (x = 0; x < w; x++) {
            yi = (x << 2) | 0;
            r = (ryp1 * (pr = px[yi])) | 0;
            g = (ryp1 * (pg = px[(yi + 1) | 0])) | 0;
            b = (ryp1 * (pb = px[(yi + 2) | 0])) | 0;
            a = (ryp1 * (pa = px[(yi + 3) | 0])) | 0;
            sy = ssy;
            for (i = 0; i < ryp1; i++) {
              sy.r = pr;
              sy.g = pg;
              sy.b = pb;
              sy.a = pa;
              sy = sy.n;
            }
            yp = w;
            for (i = 1; i <= radiusY; i++) {
              yi = (yp + x) << 2;
              r += (sy.r = px[yi]);
              g += (sy.g = px[yi + 1]);
              b += (sy.b = px[yi + 2]);
              a += (sy.a = px[yi + 3]);
              sy = sy.n;
              if (i < h1) {
                yp += w;
              }
            }
            yi = x;
            si = ssy;
            if (iterations > 0) {
              for (y = 0; y < h; y++) {
                p = yi << 2;
                px[p + 3] = pa = (a * ms) >>> ss;
                if (pa > 0) {
                  px[p] = ((r * ms) >>> ss);
                  px[p + 1] = ((g * ms) >>> ss);
                  px[p + 2] = ((b * ms) >>> ss);
                } else {
                  px[p] = px[p + 1] = px[p + 2] = 0;
                }
                p = (x + (((p = y + ryp1) < h1 ? p : h1) * w)) << 2;
                r -= si.r - (si.r = px[p]);
                g -= si.g - (si.g = px[p + 1]);
                b -= si.b - (si.b = px[p + 2]);
                a -= si.a - (si.a = px[p + 3]);
                si = si.n;
                yi += w;
              }
            } else {
              for (y = 0; y < h; y++) {
                p = yi << 2;
                px[p + 3] = pa = (a * ms) >>> ss;
                if (pa > 0) {
                  pa = 255 / pa;
                  px[p] = ((r * ms) >>> ss) * pa;
                  px[p + 1] = ((g * ms) >>> ss) * pa;
                  px[p + 2] = ((b * ms) >>> ss) * pa;
                } else {
                  px[p] = px[p + 1] = px[p + 2] = 0;
                }
                p = (x + (((p = y + ryp1) < h1 ? p : h1) * w)) << 2;
                r -= si.r - (si.r = px[p]);
                g -= si.g - (si.g = px[p + 1]);
                b -= si.b - (si.b = px[p + 2]);
                a -= si.a - (si.a = px[p + 3]);
                si = si.n;
                yi += w;
              }
            }
          }
        }
        return true;
      };
      createjs.BlurFilter = createjs.promote(BlurFilter, "Filter");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function AlphaMapFilter(alphaMap) {
        this.alphaMap = alphaMap;
        this._alphaMap = null;
        this._mapData = null;
      }
      var p = createjs.extend(AlphaMapFilter, createjs.Filter);
      p.clone = function() {
        var o = new AlphaMapFilter(this.alphaMap);
        o._alphaMap = this._alphaMap;
        o._mapData = this._mapData;
        return o;
      };
      p.toString = function() {
        return "[AlphaMapFilter]";
      };
      p._applyFilter = function(imageData) {
        if (!this.alphaMap) {
          return true;
        }
        if (!this._prepAlphaMap()) {
          return false;
        }
        var data = imageData.data;
        var map = this._mapData;
        for (var i = 0,
            l = data.length; i < l; i += 4) {
          data[i + 3] = map[i] || 0;
        }
        return true;
      };
      p._prepAlphaMap = function() {
        if (!this.alphaMap) {
          return false;
        }
        if (this.alphaMap == this._alphaMap && this._mapData) {
          return true;
        }
        this._mapData = null;
        var map = this._alphaMap = this.alphaMap;
        var canvas = map;
        var ctx;
        if (map instanceof HTMLCanvasElement) {
          ctx = canvas.getContext("2d");
        } else {
          canvas = createjs.createCanvas ? createjs.createCanvas() : document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          ctx = canvas.getContext("2d");
          ctx.drawImage(map, 0, 0);
        }
        try {
          var imgData = ctx.getImageData(0, 0, map.width, map.height);
        } catch (e) {
          return false;
        }
        this._mapData = imgData.data;
        return true;
      };
      createjs.AlphaMapFilter = createjs.promote(AlphaMapFilter, "Filter");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function AlphaMaskFilter(mask) {
        this.mask = mask;
      }
      var p = createjs.extend(AlphaMaskFilter, createjs.Filter);
      p.applyFilter = function(ctx, x, y, width, height, targetCtx, targetX, targetY) {
        if (!this.mask) {
          return true;
        }
        targetCtx = targetCtx || ctx;
        if (targetX == null) {
          targetX = x;
        }
        if (targetY == null) {
          targetY = y;
        }
        targetCtx.save();
        if (ctx != targetCtx) {
          return false;
        }
        targetCtx.globalCompositeOperation = "destination-in";
        targetCtx.drawImage(this.mask, targetX, targetY);
        targetCtx.restore();
        return true;
      };
      p.clone = function() {
        return new AlphaMaskFilter(this.mask);
      };
      p.toString = function() {
        return "[AlphaMaskFilter]";
      };
      createjs.AlphaMaskFilter = createjs.promote(AlphaMaskFilter, "Filter");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function ColorFilter(redMultiplier, greenMultiplier, blueMultiplier, alphaMultiplier, redOffset, greenOffset, blueOffset, alphaOffset) {
        this.redMultiplier = redMultiplier != null ? redMultiplier : 1;
        this.greenMultiplier = greenMultiplier != null ? greenMultiplier : 1;
        this.blueMultiplier = blueMultiplier != null ? blueMultiplier : 1;
        this.alphaMultiplier = alphaMultiplier != null ? alphaMultiplier : 1;
        this.redOffset = redOffset || 0;
        this.greenOffset = greenOffset || 0;
        this.blueOffset = blueOffset || 0;
        this.alphaOffset = alphaOffset || 0;
      }
      var p = createjs.extend(ColorFilter, createjs.Filter);
      p.toString = function() {
        return "[ColorFilter]";
      };
      p.clone = function() {
        return new ColorFilter(this.redMultiplier, this.greenMultiplier, this.blueMultiplier, this.alphaMultiplier, this.redOffset, this.greenOffset, this.blueOffset, this.alphaOffset);
      };
      p._applyFilter = function(imageData) {
        var data = imageData.data;
        var l = data.length;
        for (var i = 0; i < l; i += 4) {
          data[i] = data[i] * this.redMultiplier + this.redOffset;
          data[i + 1] = data[i + 1] * this.greenMultiplier + this.greenOffset;
          data[i + 2] = data[i + 2] * this.blueMultiplier + this.blueOffset;
          data[i + 3] = data[i + 3] * this.alphaMultiplier + this.alphaOffset;
        }
        return true;
      };
      createjs.ColorFilter = createjs.promote(ColorFilter, "Filter");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function ColorMatrix(brightness, contrast, saturation, hue) {
        this.setColor(brightness, contrast, saturation, hue);
      }
      var p = ColorMatrix.prototype;
      ColorMatrix.DELTA_INDEX = [0, 0.01, 0.02, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.11, 0.12, 0.14, 0.15, 0.16, 0.17, 0.18, 0.20, 0.21, 0.22, 0.24, 0.25, 0.27, 0.28, 0.30, 0.32, 0.34, 0.36, 0.38, 0.40, 0.42, 0.44, 0.46, 0.48, 0.5, 0.53, 0.56, 0.59, 0.62, 0.65, 0.68, 0.71, 0.74, 0.77, 0.80, 0.83, 0.86, 0.89, 0.92, 0.95, 0.98, 1.0, 1.06, 1.12, 1.18, 1.24, 1.30, 1.36, 1.42, 1.48, 1.54, 1.60, 1.66, 1.72, 1.78, 1.84, 1.90, 1.96, 2.0, 2.12, 2.25, 2.37, 2.50, 2.62, 2.75, 2.87, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0, 4.3, 4.7, 4.9, 5.0, 5.5, 6.0, 6.5, 6.8, 7.0, 7.3, 7.5, 7.8, 8.0, 8.4, 8.7, 9.0, 9.4, 9.6, 9.8, 10.0];
      ColorMatrix.IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
      ColorMatrix.LENGTH = ColorMatrix.IDENTITY_MATRIX.length;
      p.setColor = function(brightness, contrast, saturation, hue) {
        return this.reset().adjustColor(brightness, contrast, saturation, hue);
      };
      p.reset = function() {
        return this.copy(ColorMatrix.IDENTITY_MATRIX);
      };
      p.adjustColor = function(brightness, contrast, saturation, hue) {
        this.adjustHue(hue);
        this.adjustContrast(contrast);
        this.adjustBrightness(brightness);
        return this.adjustSaturation(saturation);
      };
      p.adjustBrightness = function(value) {
        if (value == 0 || isNaN(value)) {
          return this;
        }
        value = this._cleanValue(value, 255);
        this._multiplyMatrix([1, 0, 0, 0, value, 0, 1, 0, 0, value, 0, 0, 1, 0, value, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        return this;
      };
      p.adjustContrast = function(value) {
        if (value == 0 || isNaN(value)) {
          return this;
        }
        value = this._cleanValue(value, 100);
        var x;
        if (value < 0) {
          x = 127 + value / 100 * 127;
        } else {
          x = value % 1;
          if (x == 0) {
            x = ColorMatrix.DELTA_INDEX[value];
          } else {
            x = ColorMatrix.DELTA_INDEX[(value << 0)] * (1 - x) + ColorMatrix.DELTA_INDEX[(value << 0) + 1] * x;
          }
          x = x * 127 + 127;
        }
        this._multiplyMatrix([x / 127, 0, 0, 0, 0.5 * (127 - x), 0, x / 127, 0, 0, 0.5 * (127 - x), 0, 0, x / 127, 0, 0.5 * (127 - x), 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        return this;
      };
      p.adjustSaturation = function(value) {
        if (value == 0 || isNaN(value)) {
          return this;
        }
        value = this._cleanValue(value, 100);
        var x = 1 + ((value > 0) ? 3 * value / 100 : value / 100);
        var lumR = 0.3086;
        var lumG = 0.6094;
        var lumB = 0.0820;
        this._multiplyMatrix([lumR * (1 - x) + x, lumG * (1 - x), lumB * (1 - x), 0, 0, lumR * (1 - x), lumG * (1 - x) + x, lumB * (1 - x), 0, 0, lumR * (1 - x), lumG * (1 - x), lumB * (1 - x) + x, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        return this;
      };
      p.adjustHue = function(value) {
        if (value == 0 || isNaN(value)) {
          return this;
        }
        value = this._cleanValue(value, 180) / 180 * Math.PI;
        var cosVal = Math.cos(value);
        var sinVal = Math.sin(value);
        var lumR = 0.213;
        var lumG = 0.715;
        var lumB = 0.072;
        this._multiplyMatrix([lumR + cosVal * (1 - lumR) + sinVal * (-lumR), lumG + cosVal * (-lumG) + sinVal * (-lumG), lumB + cosVal * (-lumB) + sinVal * (1 - lumB), 0, 0, lumR + cosVal * (-lumR) + sinVal * (0.143), lumG + cosVal * (1 - lumG) + sinVal * (0.140), lumB + cosVal * (-lumB) + sinVal * (-0.283), 0, 0, lumR + cosVal * (-lumR) + sinVal * (-(1 - lumR)), lumG + cosVal * (-lumG) + sinVal * (lumG), lumB + cosVal * (1 - lumB) + sinVal * (lumB), 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        return this;
      };
      p.concat = function(matrix) {
        matrix = this._fixMatrix(matrix);
        if (matrix.length != ColorMatrix.LENGTH) {
          return this;
        }
        this._multiplyMatrix(matrix);
        return this;
      };
      p.clone = function() {
        return (new ColorMatrix()).copy(this);
      };
      p.toArray = function() {
        var arr = [];
        for (var i = 0,
            l = ColorMatrix.LENGTH; i < l; i++) {
          arr[i] = this[i];
        }
        return arr;
      };
      p.copy = function(matrix) {
        var l = ColorMatrix.LENGTH;
        for (var i = 0; i < l; i++) {
          this[i] = matrix[i];
        }
        return this;
      };
      p.toString = function() {
        return "[ColorMatrix]";
      };
      p._multiplyMatrix = function(matrix) {
        var i,
            j,
            k,
            col = [];
        for (i = 0; i < 5; i++) {
          for (j = 0; j < 5; j++) {
            col[j] = this[j + i * 5];
          }
          for (j = 0; j < 5; j++) {
            var val = 0;
            for (k = 0; k < 5; k++) {
              val += matrix[j + k * 5] * col[k];
            }
            this[j + i * 5] = val;
          }
        }
      };
      p._cleanValue = function(value, limit) {
        return Math.min(limit, Math.max(-limit, value));
      };
      p._fixMatrix = function(matrix) {
        if (matrix instanceof ColorMatrix) {
          matrix = matrix.toArray();
        }
        if (matrix.length < ColorMatrix.LENGTH) {
          matrix = matrix.slice(0, matrix.length).concat(ColorMatrix.IDENTITY_MATRIX.slice(matrix.length, ColorMatrix.LENGTH));
        } else if (matrix.length > ColorMatrix.LENGTH) {
          matrix = matrix.slice(0, ColorMatrix.LENGTH);
        }
        return matrix;
      };
      createjs.ColorMatrix = ColorMatrix;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function ColorMatrixFilter(matrix) {
        this.matrix = matrix;
      }
      var p = createjs.extend(ColorMatrixFilter, createjs.Filter);
      p.toString = function() {
        return "[ColorMatrixFilter]";
      };
      p.clone = function() {
        return new ColorMatrixFilter(this.matrix);
      };
      p._applyFilter = function(imageData) {
        var data = imageData.data;
        var l = data.length;
        var r,
            g,
            b,
            a;
        var mtx = this.matrix;
        var m0 = mtx[0],
            m1 = mtx[1],
            m2 = mtx[2],
            m3 = mtx[3],
            m4 = mtx[4];
        var m5 = mtx[5],
            m6 = mtx[6],
            m7 = mtx[7],
            m8 = mtx[8],
            m9 = mtx[9];
        var m10 = mtx[10],
            m11 = mtx[11],
            m12 = mtx[12],
            m13 = mtx[13],
            m14 = mtx[14];
        var m15 = mtx[15],
            m16 = mtx[16],
            m17 = mtx[17],
            m18 = mtx[18],
            m19 = mtx[19];
        for (var i = 0; i < l; i += 4) {
          r = data[i];
          g = data[i + 1];
          b = data[i + 2];
          a = data[i + 3];
          data[i] = r * m0 + g * m1 + b * m2 + a * m3 + m4;
          data[i + 1] = r * m5 + g * m6 + b * m7 + a * m8 + m9;
          data[i + 2] = r * m10 + g * m11 + b * m12 + a * m13 + m14;
          data[i + 3] = r * m15 + g * m16 + b * m17 + a * m18 + m19;
        }
        return true;
      };
      createjs.ColorMatrixFilter = createjs.promote(ColorMatrixFilter, "Filter");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Touch() {
        throw "Touch cannot be instantiated";
      }
      Touch.isSupported = function() {
        return !!(('ontouchstart' in window) || (window.navigator['msPointerEnabled'] && window.navigator['msMaxTouchPoints'] > 0) || (window.navigator['pointerEnabled'] && window.navigator['maxTouchPoints'] > 0));
      };
      Touch.enable = function(stage, singleTouch, allowDefault) {
        if (!stage || !stage.canvas || !Touch.isSupported()) {
          return false;
        }
        if (stage.__touch) {
          return true;
        }
        stage.__touch = {
          pointers: {},
          multitouch: !singleTouch,
          preventDefault: !allowDefault,
          count: 0
        };
        if ('ontouchstart' in window) {
          Touch._IOS_enable(stage);
        } else if (window.navigator['msPointerEnabled'] || window.navigator["pointerEnabled"]) {
          Touch._IE_enable(stage);
        }
        return true;
      };
      Touch.disable = function(stage) {
        if (!stage) {
          return;
        }
        if ('ontouchstart' in window) {
          Touch._IOS_disable(stage);
        } else if (window.navigator['msPointerEnabled'] || window.navigator["pointerEnabled"]) {
          Touch._IE_disable(stage);
        }
        delete stage.__touch;
      };
      Touch._IOS_enable = function(stage) {
        var canvas = stage.canvas;
        var f = stage.__touch.f = function(e) {
          Touch._IOS_handleEvent(stage, e);
        };
        canvas.addEventListener("touchstart", f, false);
        canvas.addEventListener("touchmove", f, false);
        canvas.addEventListener("touchend", f, false);
        canvas.addEventListener("touchcancel", f, false);
      };
      Touch._IOS_disable = function(stage) {
        var canvas = stage.canvas;
        if (!canvas) {
          return;
        }
        var f = stage.__touch.f;
        canvas.removeEventListener("touchstart", f, false);
        canvas.removeEventListener("touchmove", f, false);
        canvas.removeEventListener("touchend", f, false);
        canvas.removeEventListener("touchcancel", f, false);
      };
      Touch._IOS_handleEvent = function(stage, e) {
        if (!stage) {
          return;
        }
        if (stage.__touch.preventDefault) {
          e.preventDefault && e.preventDefault();
        }
        var touches = e.changedTouches;
        var type = e.type;
        for (var i = 0,
            l = touches.length; i < l; i++) {
          var touch = touches[i];
          var id = touch.identifier;
          if (touch.target != stage.canvas) {
            continue;
          }
          if (type == "touchstart") {
            this._handleStart(stage, id, e, touch.pageX, touch.pageY);
          } else if (type == "touchmove") {
            this._handleMove(stage, id, e, touch.pageX, touch.pageY);
          } else if (type == "touchend" || type == "touchcancel") {
            this._handleEnd(stage, id, e);
          }
        }
      };
      Touch._IE_enable = function(stage) {
        var canvas = stage.canvas;
        var f = stage.__touch.f = function(e) {
          Touch._IE_handleEvent(stage, e);
        };
        if (window.navigator["pointerEnabled"] === undefined) {
          canvas.addEventListener("MSPointerDown", f, false);
          window.addEventListener("MSPointerMove", f, false);
          window.addEventListener("MSPointerUp", f, false);
          window.addEventListener("MSPointerCancel", f, false);
          if (stage.__touch.preventDefault) {
            canvas.style.msTouchAction = "none";
          }
        } else {
          canvas.addEventListener("pointerdown", f, false);
          window.addEventListener("pointermove", f, false);
          window.addEventListener("pointerup", f, false);
          window.addEventListener("pointercancel", f, false);
          if (stage.__touch.preventDefault) {
            canvas.style.touchAction = "none";
          }
        }
        stage.__touch.activeIDs = {};
      };
      Touch._IE_disable = function(stage) {
        var f = stage.__touch.f;
        if (window.navigator["pointerEnabled"] === undefined) {
          window.removeEventListener("MSPointerMove", f, false);
          window.removeEventListener("MSPointerUp", f, false);
          window.removeEventListener("MSPointerCancel", f, false);
          if (stage.canvas) {
            stage.canvas.removeEventListener("MSPointerDown", f, false);
          }
        } else {
          window.removeEventListener("pointermove", f, false);
          window.removeEventListener("pointerup", f, false);
          window.removeEventListener("pointercancel", f, false);
          if (stage.canvas) {
            stage.canvas.removeEventListener("pointerdown", f, false);
          }
        }
      };
      Touch._IE_handleEvent = function(stage, e) {
        if (!stage) {
          return;
        }
        if (stage.__touch.preventDefault) {
          e.preventDefault && e.preventDefault();
        }
        var type = e.type;
        var id = e.pointerId;
        var ids = stage.__touch.activeIDs;
        if (type == "MSPointerDown" || type == "pointerdown") {
          if (e.srcElement != stage.canvas) {
            return;
          }
          ids[id] = true;
          this._handleStart(stage, id, e, e.pageX, e.pageY);
        } else if (ids[id]) {
          if (type == "MSPointerMove" || type == "pointermove") {
            this._handleMove(stage, id, e, e.pageX, e.pageY);
          } else if (type == "MSPointerUp" || type == "MSPointerCancel" || type == "pointerup" || type == "pointercancel") {
            delete(ids[id]);
            this._handleEnd(stage, id, e);
          }
        }
      };
      Touch._handleStart = function(stage, id, e, x, y) {
        var props = stage.__touch;
        if (!props.multitouch && props.count) {
          return;
        }
        var ids = props.pointers;
        if (ids[id]) {
          return;
        }
        ids[id] = true;
        props.count++;
        stage._handlePointerDown(id, e, x, y);
      };
      Touch._handleMove = function(stage, id, e, x, y) {
        if (!stage.__touch.pointers[id]) {
          return;
        }
        stage._handlePointerMove(id, e, x, y);
      };
      Touch._handleEnd = function(stage, id, e) {
        var props = stage.__touch;
        var ids = props.pointers;
        if (!ids[id]) {
          return;
        }
        props.count--;
        stage._handlePointerUp(id, e, true);
        delete(ids[id]);
      };
      createjs.Touch = Touch;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      var s = createjs.EaselJS = createjs.EaselJS || {};
      s.version = "0.8.1";
      s.buildDate = "Thu, 21 May 2015 16:17:39 GMT";
    })();
  })();
  return _retrieveGlobal();
});

System.registerDynamic("github:CreateJS/TweenJS@0.6.1/lib/tweenjs-0.6.1.combined.js", [], false, function(__require, __exports, __module) {
  var _retrieveGlobal = System.get("@@global-helpers").prepareGlobal(__module.id, null, null);
  (function() {
    this.createjs = this.createjs || {};
    createjs.extend = function(subclass, superclass) {
      "use strict";
      function o() {
        this.constructor = subclass;
      }
      o.prototype = superclass.prototype;
      return (subclass.prototype = new o());
    };
    this.createjs = this.createjs || {};
    createjs.promote = function(subclass, prefix) {
      "use strict";
      var subP = subclass.prototype,
          supP = (Object.getPrototypeOf && Object.getPrototypeOf(subP)) || subP.__proto__;
      if (supP) {
        subP[(prefix += "_") + "constructor"] = supP.constructor;
        for (var n in supP) {
          if (subP.hasOwnProperty(n) && (typeof supP[n] == "function")) {
            subP[prefix + n] = supP[n];
          }
        }
      }
      return subclass;
    };
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Event(type, bubbles, cancelable) {
        this.type = type;
        this.target = null;
        this.currentTarget = null;
        this.eventPhase = 0;
        this.bubbles = !!bubbles;
        this.cancelable = !!cancelable;
        this.timeStamp = (new Date()).getTime();
        this.defaultPrevented = false;
        this.propagationStopped = false;
        this.immediatePropagationStopped = false;
        this.removed = false;
      }
      var p = Event.prototype;
      p.preventDefault = function() {
        this.defaultPrevented = this.cancelable && true;
      };
      p.stopPropagation = function() {
        this.propagationStopped = true;
      };
      p.stopImmediatePropagation = function() {
        this.immediatePropagationStopped = this.propagationStopped = true;
      };
      p.remove = function() {
        this.removed = true;
      };
      p.clone = function() {
        return new Event(this.type, this.bubbles, this.cancelable);
      };
      p.set = function(props) {
        for (var n in props) {
          this[n] = props[n];
        }
        return this;
      };
      p.toString = function() {
        return "[Event (type=" + this.type + ")]";
      };
      createjs.Event = Event;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function EventDispatcher() {
        this._listeners = null;
        this._captureListeners = null;
      }
      var p = EventDispatcher.prototype;
      EventDispatcher.initialize = function(target) {
        target.addEventListener = p.addEventListener;
        target.on = p.on;
        target.removeEventListener = target.off = p.removeEventListener;
        target.removeAllEventListeners = p.removeAllEventListeners;
        target.hasEventListener = p.hasEventListener;
        target.dispatchEvent = p.dispatchEvent;
        target._dispatchEvent = p._dispatchEvent;
        target.willTrigger = p.willTrigger;
      };
      p.addEventListener = function(type, listener, useCapture) {
        var listeners;
        if (useCapture) {
          listeners = this._captureListeners = this._captureListeners || {};
        } else {
          listeners = this._listeners = this._listeners || {};
        }
        var arr = listeners[type];
        if (arr) {
          this.removeEventListener(type, listener, useCapture);
        }
        arr = listeners[type];
        if (!arr) {
          listeners[type] = [listener];
        } else {
          arr.push(listener);
        }
        return listener;
      };
      p.on = function(type, listener, scope, once, data, useCapture) {
        if (listener.handleEvent) {
          scope = scope || listener;
          listener = listener.handleEvent;
        }
        scope = scope || this;
        return this.addEventListener(type, function(evt) {
          listener.call(scope, evt, data);
          once && evt.remove();
        }, useCapture);
      };
      p.removeEventListener = function(type, listener, useCapture) {
        var listeners = useCapture ? this._captureListeners : this._listeners;
        if (!listeners) {
          return;
        }
        var arr = listeners[type];
        if (!arr) {
          return;
        }
        for (var i = 0,
            l = arr.length; i < l; i++) {
          if (arr[i] == listener) {
            if (l == 1) {
              delete(listeners[type]);
            } else {
              arr.splice(i, 1);
            }
            break;
          }
        }
      };
      p.off = p.removeEventListener;
      p.removeAllEventListeners = function(type) {
        if (!type) {
          this._listeners = this._captureListeners = null;
        } else {
          if (this._listeners) {
            delete(this._listeners[type]);
          }
          if (this._captureListeners) {
            delete(this._captureListeners[type]);
          }
        }
      };
      p.dispatchEvent = function(eventObj) {
        if (typeof eventObj == "string") {
          var listeners = this._listeners;
          if (!listeners || !listeners[eventObj]) {
            return false;
          }
          eventObj = new createjs.Event(eventObj);
        } else if (eventObj.target && eventObj.clone) {
          eventObj = eventObj.clone();
        }
        try {
          eventObj.target = this;
        } catch (e) {}
        if (!eventObj.bubbles || !this.parent) {
          this._dispatchEvent(eventObj, 2);
        } else {
          var top = this,
              list = [top];
          while (top.parent) {
            list.push(top = top.parent);
          }
          var i,
              l = list.length;
          for (i = l - 1; i >= 0 && !eventObj.propagationStopped; i--) {
            list[i]._dispatchEvent(eventObj, 1 + (i == 0));
          }
          for (i = 1; i < l && !eventObj.propagationStopped; i++) {
            list[i]._dispatchEvent(eventObj, 3);
          }
        }
        return eventObj.defaultPrevented;
      };
      p.hasEventListener = function(type) {
        var listeners = this._listeners,
            captureListeners = this._captureListeners;
        return !!((listeners && listeners[type]) || (captureListeners && captureListeners[type]));
      };
      p.willTrigger = function(type) {
        var o = this;
        while (o) {
          if (o.hasEventListener(type)) {
            return true;
          }
          o = o.parent;
        }
        return false;
      };
      p.toString = function() {
        return "[EventDispatcher]";
      };
      p._dispatchEvent = function(eventObj, eventPhase) {
        var l,
            listeners = (eventPhase == 1) ? this._captureListeners : this._listeners;
        if (eventObj && listeners) {
          var arr = listeners[eventObj.type];
          if (!arr || !(l = arr.length)) {
            return;
          }
          try {
            eventObj.currentTarget = this;
          } catch (e) {}
          try {
            eventObj.eventPhase = eventPhase;
          } catch (e) {}
          eventObj.removed = false;
          arr = arr.slice();
          for (var i = 0; i < l && !eventObj.immediatePropagationStopped; i++) {
            var o = arr[i];
            if (o.handleEvent) {
              o.handleEvent(eventObj);
            } else {
              o(eventObj);
            }
            if (eventObj.removed) {
              this.off(eventObj.type, o, eventPhase == 1);
              eventObj.removed = false;
            }
          }
        }
      };
      createjs.EventDispatcher = EventDispatcher;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Ticker() {
        throw "Ticker cannot be instantiated.";
      }
      Ticker.RAF_SYNCHED = "synched";
      Ticker.RAF = "raf";
      Ticker.TIMEOUT = "timeout";
      Ticker.useRAF = false;
      Ticker.timingMode = null;
      Ticker.maxDelta = 0;
      Ticker.paused = false;
      Ticker.removeEventListener = null;
      Ticker.removeAllEventListeners = null;
      Ticker.dispatchEvent = null;
      Ticker.hasEventListener = null;
      Ticker._listeners = null;
      createjs.EventDispatcher.initialize(Ticker);
      Ticker._addEventListener = Ticker.addEventListener;
      Ticker.addEventListener = function() {
        !Ticker._inited && Ticker.init();
        return Ticker._addEventListener.apply(Ticker, arguments);
      };
      Ticker._inited = false;
      Ticker._startTime = 0;
      Ticker._pausedTime = 0;
      Ticker._ticks = 0;
      Ticker._pausedTicks = 0;
      Ticker._interval = 50;
      Ticker._lastTime = 0;
      Ticker._times = null;
      Ticker._tickTimes = null;
      Ticker._timerId = null;
      Ticker._raf = true;
      Ticker.setInterval = function(interval) {
        Ticker._interval = interval;
        if (!Ticker._inited) {
          return;
        }
        Ticker._setupTick();
      };
      Ticker.getInterval = function() {
        return Ticker._interval;
      };
      Ticker.setFPS = function(value) {
        Ticker.setInterval(1000 / value);
      };
      Ticker.getFPS = function() {
        return 1000 / Ticker._interval;
      };
      try {
        Object.defineProperties(Ticker, {
          interval: {
            get: Ticker.getInterval,
            set: Ticker.setInterval
          },
          framerate: {
            get: Ticker.getFPS,
            set: Ticker.setFPS
          }
        });
      } catch (e) {
        console.log(e);
      }
      Ticker.init = function() {
        if (Ticker._inited) {
          return;
        }
        Ticker._inited = true;
        Ticker._times = [];
        Ticker._tickTimes = [];
        Ticker._startTime = Ticker._getTime();
        Ticker._times.push(Ticker._lastTime = 0);
        Ticker.interval = Ticker._interval;
      };
      Ticker.reset = function() {
        if (Ticker._raf) {
          var f = window.cancelAnimationFrame || window.webkitCancelAnimationFrame || window.mozCancelAnimationFrame || window.oCancelAnimationFrame || window.msCancelAnimationFrame;
          f && f(Ticker._timerId);
        } else {
          clearTimeout(Ticker._timerId);
        }
        Ticker.removeAllEventListeners("tick");
        Ticker._timerId = Ticker._times = Ticker._tickTimes = null;
        Ticker._startTime = Ticker._lastTime = Ticker._ticks = 0;
        Ticker._inited = false;
      };
      Ticker.getMeasuredTickTime = function(ticks) {
        var ttl = 0,
            times = Ticker._tickTimes;
        if (!times || times.length < 1) {
          return -1;
        }
        ticks = Math.min(times.length, ticks || (Ticker.getFPS() | 0));
        for (var i = 0; i < ticks; i++) {
          ttl += times[i];
        }
        return ttl / ticks;
      };
      Ticker.getMeasuredFPS = function(ticks) {
        var times = Ticker._times;
        if (!times || times.length < 2) {
          return -1;
        }
        ticks = Math.min(times.length - 1, ticks || (Ticker.getFPS() | 0));
        return 1000 / ((times[0] - times[ticks]) / ticks);
      };
      Ticker.setPaused = function(value) {
        Ticker.paused = value;
      };
      Ticker.getPaused = function() {
        return Ticker.paused;
      };
      Ticker.getTime = function(runTime) {
        return Ticker._startTime ? Ticker._getTime() - (runTime ? Ticker._pausedTime : 0) : -1;
      };
      Ticker.getEventTime = function(runTime) {
        return Ticker._startTime ? (Ticker._lastTime || Ticker._startTime) - (runTime ? Ticker._pausedTime : 0) : -1;
      };
      Ticker.getTicks = function(pauseable) {
        return Ticker._ticks - (pauseable ? Ticker._pausedTicks : 0);
      };
      Ticker._handleSynch = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        if (Ticker._getTime() - Ticker._lastTime >= (Ticker._interval - 1) * 0.97) {
          Ticker._tick();
        }
      };
      Ticker._handleRAF = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        Ticker._tick();
      };
      Ticker._handleTimeout = function() {
        Ticker._timerId = null;
        Ticker._setupTick();
        Ticker._tick();
      };
      Ticker._setupTick = function() {
        if (Ticker._timerId != null) {
          return;
        }
        var mode = Ticker.timingMode || (Ticker.useRAF && Ticker.RAF_SYNCHED);
        if (mode == Ticker.RAF_SYNCHED || mode == Ticker.RAF) {
          var f = window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.oRequestAnimationFrame || window.msRequestAnimationFrame;
          if (f) {
            Ticker._timerId = f(mode == Ticker.RAF ? Ticker._handleRAF : Ticker._handleSynch);
            Ticker._raf = true;
            return;
          }
        }
        Ticker._raf = false;
        Ticker._timerId = setTimeout(Ticker._handleTimeout, Ticker._interval);
      };
      Ticker._tick = function() {
        var paused = Ticker.paused;
        var time = Ticker._getTime();
        var elapsedTime = time - Ticker._lastTime;
        Ticker._lastTime = time;
        Ticker._ticks++;
        if (paused) {
          Ticker._pausedTicks++;
          Ticker._pausedTime += elapsedTime;
        }
        if (Ticker.hasEventListener("tick")) {
          var event = new createjs.Event("tick");
          var maxDelta = Ticker.maxDelta;
          event.delta = (maxDelta && elapsedTime > maxDelta) ? maxDelta : elapsedTime;
          event.paused = paused;
          event.time = time;
          event.runTime = time - Ticker._pausedTime;
          Ticker.dispatchEvent(event);
        }
        Ticker._tickTimes.unshift(Ticker._getTime() - time);
        while (Ticker._tickTimes.length > 100) {
          Ticker._tickTimes.pop();
        }
        Ticker._times.unshift(time);
        while (Ticker._times.length > 100) {
          Ticker._times.pop();
        }
      };
      var now = window.performance && (performance.now || performance.mozNow || performance.msNow || performance.oNow || performance.webkitNow);
      Ticker._getTime = function() {
        return ((now && now.call(performance)) || (new Date().getTime())) - Ticker._startTime;
      };
      createjs.Ticker = Ticker;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Tween(target, props, pluginData) {
        this.ignoreGlobalPause = false;
        this.loop = false;
        this.duration = 0;
        this.pluginData = pluginData || {};
        this.target = target;
        this.position = null;
        this.passive = false;
        this._paused = false;
        this._curQueueProps = {};
        this._initQueueProps = {};
        this._steps = [];
        this._actions = [];
        this._prevPosition = 0;
        this._stepPosition = 0;
        this._prevPos = -1;
        this._target = target;
        this._useTicks = false;
        this._inited = false;
        this._registered = false;
        if (props) {
          this._useTicks = props.useTicks;
          this.ignoreGlobalPause = props.ignoreGlobalPause;
          this.loop = props.loop;
          props.onChange && this.addEventListener("change", props.onChange);
          if (props.override) {
            Tween.removeTweens(target);
          }
        }
        if (props && props.paused) {
          this._paused = true;
        } else {
          createjs.Tween._register(this, true);
        }
        if (props && props.position != null) {
          this.setPosition(props.position, Tween.NONE);
        }
      }
      ;
      var p = createjs.extend(Tween, createjs.EventDispatcher);
      Tween.NONE = 0;
      Tween.LOOP = 1;
      Tween.REVERSE = 2;
      Tween.IGNORE = {};
      Tween._tweens = [];
      Tween._plugins = {};
      Tween.get = function(target, props, pluginData, override) {
        if (override) {
          Tween.removeTweens(target);
        }
        return new Tween(target, props, pluginData);
      };
      Tween.tick = function(delta, paused) {
        var tweens = Tween._tweens.slice();
        for (var i = tweens.length - 1; i >= 0; i--) {
          var tween = tweens[i];
          if ((paused && !tween.ignoreGlobalPause) || tween._paused) {
            continue;
          }
          tween.tick(tween._useTicks ? 1 : delta);
        }
      };
      Tween.handleEvent = function(event) {
        if (event.type == "tick") {
          this.tick(event.delta, event.paused);
        }
      };
      Tween.removeTweens = function(target) {
        if (!target.tweenjs_count) {
          return;
        }
        var tweens = Tween._tweens;
        for (var i = tweens.length - 1; i >= 0; i--) {
          var tween = tweens[i];
          if (tween._target == target) {
            tween._paused = true;
            tweens.splice(i, 1);
          }
        }
        target.tweenjs_count = 0;
      };
      Tween.removeAllTweens = function() {
        var tweens = Tween._tweens;
        for (var i = 0,
            l = tweens.length; i < l; i++) {
          var tween = tweens[i];
          tween._paused = true;
          tween.target && (tween.target.tweenjs_count = 0);
        }
        tweens.length = 0;
      };
      Tween.hasActiveTweens = function(target) {
        if (target) {
          return target.tweenjs_count != null && !!target.tweenjs_count;
        }
        return Tween._tweens && !!Tween._tweens.length;
      };
      Tween.installPlugin = function(plugin, properties) {
        var priority = plugin.priority;
        if (priority == null) {
          plugin.priority = priority = 0;
        }
        for (var i = 0,
            l = properties.length,
            p = Tween._plugins; i < l; i++) {
          var n = properties[i];
          if (!p[n]) {
            p[n] = [plugin];
          } else {
            var arr = p[n];
            for (var j = 0,
                jl = arr.length; j < jl; j++) {
              if (priority < arr[j].priority) {
                break;
              }
            }
            p[n].splice(j, 0, plugin);
          }
        }
      };
      Tween._register = function(tween, value) {
        var target = tween._target;
        var tweens = Tween._tweens;
        if (value && !tween._registered) {
          if (target) {
            target.tweenjs_count = target.tweenjs_count ? target.tweenjs_count + 1 : 1;
          }
          tweens.push(tween);
          if (!Tween._inited && createjs.Ticker) {
            createjs.Ticker.addEventListener("tick", Tween);
            Tween._inited = true;
          }
        } else if (!value && tween._registered) {
          if (target) {
            target.tweenjs_count--;
          }
          var i = tweens.length;
          while (i--) {
            if (tweens[i] == tween) {
              tweens.splice(i, 1);
              break;
            }
          }
        }
        tween._registered = value;
      };
      p.wait = function(duration, passive) {
        if (duration == null || duration <= 0) {
          return this;
        }
        var o = this._cloneProps(this._curQueueProps);
        return this._addStep({
          d: duration,
          p0: o,
          e: this._linearEase,
          p1: o,
          v: passive
        });
      };
      p.to = function(props, duration, ease) {
        if (isNaN(duration) || duration < 0) {
          duration = 0;
        }
        return this._addStep({
          d: duration || 0,
          p0: this._cloneProps(this._curQueueProps),
          e: ease,
          p1: this._cloneProps(this._appendQueueProps(props))
        });
      };
      p.call = function(callback, params, scope) {
        return this._addAction({
          f: callback,
          p: params ? params : [this],
          o: scope ? scope : this._target
        });
      };
      p.set = function(props, target) {
        return this._addAction({
          f: this._set,
          o: this,
          p: [props, target ? target : this._target]
        });
      };
      p.play = function(tween) {
        if (!tween) {
          tween = this;
        }
        return this.call(tween.setPaused, [false], tween);
      };
      p.pause = function(tween) {
        if (!tween) {
          tween = this;
        }
        return this.call(tween.setPaused, [true], tween);
      };
      p.setPosition = function(value, actionsMode) {
        if (value < 0) {
          value = 0;
        }
        if (actionsMode == null) {
          actionsMode = 1;
        }
        var t = value;
        var end = false;
        if (t >= this.duration) {
          if (this.loop) {
            t = t % this.duration;
          } else {
            t = this.duration;
            end = true;
          }
        }
        if (t == this._prevPos) {
          return end;
        }
        var prevPos = this._prevPos;
        this.position = this._prevPos = t;
        this._prevPosition = value;
        if (this._target) {
          if (end) {
            this._updateTargetProps(null, 1);
          } else if (this._steps.length > 0) {
            for (var i = 0,
                l = this._steps.length; i < l; i++) {
              if (this._steps[i].t > t) {
                break;
              }
            }
            var step = this._steps[i - 1];
            this._updateTargetProps(step, (this._stepPosition = t - step.t) / step.d);
          }
        }
        if (actionsMode != 0 && this._actions.length > 0) {
          if (this._useTicks) {
            this._runActions(t, t);
          } else if (actionsMode == 1 && t < prevPos) {
            if (prevPos != this.duration) {
              this._runActions(prevPos, this.duration);
            }
            this._runActions(0, t, true);
          } else {
            this._runActions(prevPos, t);
          }
        }
        if (end) {
          this.setPaused(true);
        }
        this.dispatchEvent("change");
        return end;
      };
      p.tick = function(delta) {
        if (this._paused) {
          return;
        }
        this.setPosition(this._prevPosition + delta);
      };
      p.setPaused = function(value) {
        if (this._paused === !!value) {
          return this;
        }
        this._paused = !!value;
        Tween._register(this, !value);
        return this;
      };
      p.w = p.wait;
      p.t = p.to;
      p.c = p.call;
      p.s = p.set;
      p.toString = function() {
        return "[Tween]";
      };
      p.clone = function() {
        throw ("Tween can not be cloned.");
      };
      p._updateTargetProps = function(step, ratio) {
        var p0,
            p1,
            v,
            v0,
            v1,
            arr;
        if (!step && ratio == 1) {
          this.passive = false;
          p0 = p1 = this._curQueueProps;
        } else {
          this.passive = !!step.v;
          if (this.passive) {
            return;
          }
          if (step.e) {
            ratio = step.e(ratio, 0, 1, 1);
          }
          p0 = step.p0;
          p1 = step.p1;
        }
        for (var n in this._initQueueProps) {
          if ((v0 = p0[n]) == null) {
            p0[n] = v0 = this._initQueueProps[n];
          }
          if ((v1 = p1[n]) == null) {
            p1[n] = v1 = v0;
          }
          if (v0 == v1 || ratio == 0 || ratio == 1 || (typeof(v0) != "number")) {
            v = ratio == 1 ? v1 : v0;
          } else {
            v = v0 + (v1 - v0) * ratio;
          }
          var ignore = false;
          if (arr = Tween._plugins[n]) {
            for (var i = 0,
                l = arr.length; i < l; i++) {
              var v2 = arr[i].tween(this, n, v, p0, p1, ratio, !!step && p0 == p1, !step);
              if (v2 == Tween.IGNORE) {
                ignore = true;
              } else {
                v = v2;
              }
            }
          }
          if (!ignore) {
            this._target[n] = v;
          }
        }
      };
      p._runActions = function(startPos, endPos, includeStart) {
        var sPos = startPos;
        var ePos = endPos;
        var i = -1;
        var j = this._actions.length;
        var k = 1;
        if (startPos > endPos) {
          sPos = endPos;
          ePos = startPos;
          i = j;
          j = k = -1;
        }
        while ((i += k) != j) {
          var action = this._actions[i];
          var pos = action.t;
          if (pos == ePos || (pos > sPos && pos < ePos) || (includeStart && pos == startPos)) {
            action.f.apply(action.o, action.p);
          }
        }
      };
      p._appendQueueProps = function(o) {
        var arr,
            oldValue,
            i,
            l,
            injectProps;
        for (var n in o) {
          if (this._initQueueProps[n] === undefined) {
            oldValue = this._target[n];
            if (arr = Tween._plugins[n]) {
              for (i = 0, l = arr.length; i < l; i++) {
                oldValue = arr[i].init(this, n, oldValue);
              }
            }
            this._initQueueProps[n] = this._curQueueProps[n] = (oldValue === undefined) ? null : oldValue;
          } else {
            oldValue = this._curQueueProps[n];
          }
        }
        for (var n in o) {
          oldValue = this._curQueueProps[n];
          if (arr = Tween._plugins[n]) {
            injectProps = injectProps || {};
            for (i = 0, l = arr.length; i < l; i++) {
              if (arr[i].step) {
                arr[i].step(this, n, oldValue, o[n], injectProps);
              }
            }
          }
          this._curQueueProps[n] = o[n];
        }
        if (injectProps) {
          this._appendQueueProps(injectProps);
        }
        return this._curQueueProps;
      };
      p._cloneProps = function(props) {
        var o = {};
        for (var n in props) {
          o[n] = props[n];
        }
        return o;
      };
      p._addStep = function(o) {
        if (o.d > 0) {
          this._steps.push(o);
          o.t = this.duration;
          this.duration += o.d;
        }
        return this;
      };
      p._addAction = function(o) {
        o.t = this.duration;
        this._actions.push(o);
        return this;
      };
      p._set = function(props, o) {
        for (var n in props) {
          o[n] = props[n];
        }
      };
      createjs.Tween = createjs.promote(Tween, "EventDispatcher");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Timeline(tweens, labels, props) {
        this.EventDispatcher_constructor();
        this.ignoreGlobalPause = false;
        this.duration = 0;
        this.loop = false;
        this.position = null;
        this._paused = false;
        this._tweens = [];
        this._labels = null;
        this._labelList = null;
        this._prevPosition = 0;
        this._prevPos = -1;
        this._useTicks = false;
        this._registered = false;
        if (props) {
          this._useTicks = props.useTicks;
          this.loop = props.loop;
          this.ignoreGlobalPause = props.ignoreGlobalPause;
          props.onChange && this.addEventListener("change", props.onChange);
        }
        if (tweens) {
          this.addTween.apply(this, tweens);
        }
        this.setLabels(labels);
        if (props && props.paused) {
          this._paused = true;
        } else {
          createjs.Tween._register(this, true);
        }
        if (props && props.position != null) {
          this.setPosition(props.position, createjs.Tween.NONE);
        }
      }
      ;
      var p = createjs.extend(Timeline, createjs.EventDispatcher);
      p.addTween = function(tween) {
        var l = arguments.length;
        if (l > 1) {
          for (var i = 0; i < l; i++) {
            this.addTween(arguments[i]);
          }
          return arguments[0];
        } else if (l == 0) {
          return null;
        }
        this.removeTween(tween);
        this._tweens.push(tween);
        tween.setPaused(true);
        tween._paused = false;
        tween._useTicks = this._useTicks;
        if (tween.duration > this.duration) {
          this.duration = tween.duration;
        }
        if (this._prevPos >= 0) {
          tween.setPosition(this._prevPos, createjs.Tween.NONE);
        }
        return tween;
      };
      p.removeTween = function(tween) {
        var l = arguments.length;
        if (l > 1) {
          var good = true;
          for (var i = 0; i < l; i++) {
            good = good && this.removeTween(arguments[i]);
          }
          return good;
        } else if (l == 0) {
          return false;
        }
        var tweens = this._tweens;
        var i = tweens.length;
        while (i--) {
          if (tweens[i] == tween) {
            tweens.splice(i, 1);
            if (tween.duration >= this.duration) {
              this.updateDuration();
            }
            return true;
          }
        }
        return false;
      };
      p.addLabel = function(label, position) {
        this._labels[label] = position;
        var list = this._labelList;
        if (list) {
          for (var i = 0,
              l = list.length; i < l; i++) {
            if (position < list[i].position) {
              break;
            }
          }
          list.splice(i, 0, {
            label: label,
            position: position
          });
        }
      };
      p.setLabels = function(o) {
        this._labels = o ? o : {};
      };
      p.getLabels = function() {
        var list = this._labelList;
        if (!list) {
          list = this._labelList = [];
          var labels = this._labels;
          for (var n in labels) {
            list.push({
              label: n,
              position: labels[n]
            });
          }
          list.sort(function(a, b) {
            return a.position - b.position;
          });
        }
        return list;
      };
      p.getCurrentLabel = function() {
        var labels = this.getLabels();
        var pos = this.position;
        var l = labels.length;
        if (l) {
          for (var i = 0; i < l; i++) {
            if (pos < labels[i].position) {
              break;
            }
          }
          return (i == 0) ? null : labels[i - 1].label;
        }
        return null;
      };
      p.gotoAndPlay = function(positionOrLabel) {
        this.setPaused(false);
        this._goto(positionOrLabel);
      };
      p.gotoAndStop = function(positionOrLabel) {
        this.setPaused(true);
        this._goto(positionOrLabel);
      };
      p.setPosition = function(value, actionsMode) {
        var t = this._calcPosition(value);
        var end = !this.loop && value >= this.duration;
        if (t == this._prevPos) {
          return end;
        }
        this._prevPosition = value;
        this.position = this._prevPos = t;
        for (var i = 0,
            l = this._tweens.length; i < l; i++) {
          this._tweens[i].setPosition(t, actionsMode);
          if (t != this._prevPos) {
            return false;
          }
        }
        if (end) {
          this.setPaused(true);
        }
        this.dispatchEvent("change");
        return end;
      };
      p.setPaused = function(value) {
        this._paused = !!value;
        createjs.Tween._register(this, !value);
      };
      p.updateDuration = function() {
        this.duration = 0;
        for (var i = 0,
            l = this._tweens.length; i < l; i++) {
          var tween = this._tweens[i];
          if (tween.duration > this.duration) {
            this.duration = tween.duration;
          }
        }
      };
      p.tick = function(delta) {
        this.setPosition(this._prevPosition + delta);
      };
      p.resolve = function(positionOrLabel) {
        var pos = Number(positionOrLabel);
        if (isNaN(pos)) {
          pos = this._labels[positionOrLabel];
        }
        return pos;
      };
      p.toString = function() {
        return "[Timeline]";
      };
      p.clone = function() {
        throw ("Timeline can not be cloned.");
      };
      p._goto = function(positionOrLabel) {
        var pos = this.resolve(positionOrLabel);
        if (pos != null) {
          this.setPosition(pos);
        }
      };
      p._calcPosition = function(value) {
        if (value < 0) {
          return 0;
        }
        if (value < this.duration) {
          return value;
        }
        return this.loop ? value % this.duration : this.duration;
      };
      createjs.Timeline = createjs.promote(Timeline, "EventDispatcher");
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function Ease() {
        throw "Ease cannot be instantiated.";
      }
      Ease.linear = function(t) {
        return t;
      };
      Ease.none = Ease.linear;
      Ease.get = function(amount) {
        if (amount < -1) {
          amount = -1;
        }
        if (amount > 1) {
          amount = 1;
        }
        return function(t) {
          if (amount == 0) {
            return t;
          }
          if (amount < 0) {
            return t * (t * -amount + 1 + amount);
          }
          return t * ((2 - t) * amount + (1 - amount));
        };
      };
      Ease.getPowIn = function(pow) {
        return function(t) {
          return Math.pow(t, pow);
        };
      };
      Ease.getPowOut = function(pow) {
        return function(t) {
          return 1 - Math.pow(1 - t, pow);
        };
      };
      Ease.getPowInOut = function(pow) {
        return function(t) {
          if ((t *= 2) < 1)
            return 0.5 * Math.pow(t, pow);
          return 1 - 0.5 * Math.abs(Math.pow(2 - t, pow));
        };
      };
      Ease.quadIn = Ease.getPowIn(2);
      Ease.quadOut = Ease.getPowOut(2);
      Ease.quadInOut = Ease.getPowInOut(2);
      Ease.cubicIn = Ease.getPowIn(3);
      Ease.cubicOut = Ease.getPowOut(3);
      Ease.cubicInOut = Ease.getPowInOut(3);
      Ease.quartIn = Ease.getPowIn(4);
      Ease.quartOut = Ease.getPowOut(4);
      Ease.quartInOut = Ease.getPowInOut(4);
      Ease.quintIn = Ease.getPowIn(5);
      Ease.quintOut = Ease.getPowOut(5);
      Ease.quintInOut = Ease.getPowInOut(5);
      Ease.sineIn = function(t) {
        return 1 - Math.cos(t * Math.PI / 2);
      };
      Ease.sineOut = function(t) {
        return Math.sin(t * Math.PI / 2);
      };
      Ease.sineInOut = function(t) {
        return -0.5 * (Math.cos(Math.PI * t) - 1);
      };
      Ease.getBackIn = function(amount) {
        return function(t) {
          return t * t * ((amount + 1) * t - amount);
        };
      };
      Ease.backIn = Ease.getBackIn(1.7);
      Ease.getBackOut = function(amount) {
        return function(t) {
          return (--t * t * ((amount + 1) * t + amount) + 1);
        };
      };
      Ease.backOut = Ease.getBackOut(1.7);
      Ease.getBackInOut = function(amount) {
        amount *= 1.525;
        return function(t) {
          if ((t *= 2) < 1)
            return 0.5 * (t * t * ((amount + 1) * t - amount));
          return 0.5 * ((t -= 2) * t * ((amount + 1) * t + amount) + 2);
        };
      };
      Ease.backInOut = Ease.getBackInOut(1.7);
      Ease.circIn = function(t) {
        return -(Math.sqrt(1 - t * t) - 1);
      };
      Ease.circOut = function(t) {
        return Math.sqrt(1 - (--t) * t);
      };
      Ease.circInOut = function(t) {
        if ((t *= 2) < 1)
          return -0.5 * (Math.sqrt(1 - t * t) - 1);
        return 0.5 * (Math.sqrt(1 - (t -= 2) * t) + 1);
      };
      Ease.bounceIn = function(t) {
        return 1 - Ease.bounceOut(1 - t);
      };
      Ease.bounceOut = function(t) {
        if (t < 1 / 2.75) {
          return (7.5625 * t * t);
        } else if (t < 2 / 2.75) {
          return (7.5625 * (t -= 1.5 / 2.75) * t + 0.75);
        } else if (t < 2.5 / 2.75) {
          return (7.5625 * (t -= 2.25 / 2.75) * t + 0.9375);
        } else {
          return (7.5625 * (t -= 2.625 / 2.75) * t + 0.984375);
        }
      };
      Ease.bounceInOut = function(t) {
        if (t < 0.5)
          return Ease.bounceIn(t * 2) * .5;
        return Ease.bounceOut(t * 2 - 1) * 0.5 + 0.5;
      };
      Ease.getElasticIn = function(amplitude, period) {
        var pi2 = Math.PI * 2;
        return function(t) {
          if (t == 0 || t == 1)
            return t;
          var s = period / pi2 * Math.asin(1 / amplitude);
          return -(amplitude * Math.pow(2, 10 * (t -= 1)) * Math.sin((t - s) * pi2 / period));
        };
      };
      Ease.elasticIn = Ease.getElasticIn(1, 0.3);
      Ease.getElasticOut = function(amplitude, period) {
        var pi2 = Math.PI * 2;
        return function(t) {
          if (t == 0 || t == 1)
            return t;
          var s = period / pi2 * Math.asin(1 / amplitude);
          return (amplitude * Math.pow(2, -10 * t) * Math.sin((t - s) * pi2 / period) + 1);
        };
      };
      Ease.elasticOut = Ease.getElasticOut(1, 0.3);
      Ease.getElasticInOut = function(amplitude, period) {
        var pi2 = Math.PI * 2;
        return function(t) {
          var s = period / pi2 * Math.asin(1 / amplitude);
          if ((t *= 2) < 1)
            return -0.5 * (amplitude * Math.pow(2, 10 * (t -= 1)) * Math.sin((t - s) * pi2 / period));
          return amplitude * Math.pow(2, -10 * (t -= 1)) * Math.sin((t - s) * pi2 / period) * 0.5 + 1;
        };
      };
      Ease.elasticInOut = Ease.getElasticInOut(1, 0.3 * 1.5);
      createjs.Ease = Ease;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      function MotionGuidePlugin() {
        throw ("MotionGuidePlugin cannot be instantiated.");
      }
      ;
      MotionGuidePlugin.priority = 0;
      MotionGuidePlugin._rotOffS;
      MotionGuidePlugin._rotOffE;
      MotionGuidePlugin._rotNormS;
      MotionGuidePlugin._rotNormE;
      MotionGuidePlugin.install = function() {
        createjs.Tween.installPlugin(MotionGuidePlugin, ["guide", "x", "y", "rotation"]);
        return createjs.Tween.IGNORE;
      };
      MotionGuidePlugin.init = function(tween, prop, value) {
        var target = tween.target;
        if (!target.hasOwnProperty("x")) {
          target.x = 0;
        }
        if (!target.hasOwnProperty("y")) {
          target.y = 0;
        }
        if (!target.hasOwnProperty("rotation")) {
          target.rotation = 0;
        }
        if (prop == "rotation") {
          tween.__needsRot = true;
        }
        return prop == "guide" ? null : value;
      };
      MotionGuidePlugin.step = function(tween, prop, startValue, endValue, injectProps) {
        if (prop == "rotation") {
          tween.__rotGlobalS = startValue;
          tween.__rotGlobalE = endValue;
          MotionGuidePlugin.testRotData(tween, injectProps);
        }
        if (prop != "guide") {
          return endValue;
        }
        var temp,
            data = endValue;
        if (!data.hasOwnProperty("path")) {
          data.path = [];
        }
        var path = data.path;
        if (!data.hasOwnProperty("end")) {
          data.end = 1;
        }
        if (!data.hasOwnProperty("start")) {
          data.start = (startValue && startValue.hasOwnProperty("end") && startValue.path === path) ? startValue.end : 0;
        }
        if (data.hasOwnProperty("_segments") && data._length) {
          return endValue;
        }
        var l = path.length;
        var accuracy = 10;
        if (l >= 6 && (l - 2) % 4 == 0) {
          data._segments = [];
          data._length = 0;
          for (var i = 2; i < l; i += 4) {
            var sx = path[i - 2],
                sy = path[i - 1];
            var cx = path[i + 0],
                cy = path[i + 1];
            var ex = path[i + 2],
                ey = path[i + 3];
            var oldX = sx,
                oldY = sy;
            var tempX,
                tempY,
                total = 0;
            var sublines = [];
            for (var j = 1; j <= accuracy; j++) {
              var t = j / accuracy;
              var inv = 1 - t;
              tempX = inv * inv * sx + 2 * inv * t * cx + t * t * ex;
              tempY = inv * inv * sy + 2 * inv * t * cy + t * t * ey;
              total += sublines[sublines.push(Math.sqrt((temp = tempX - oldX) * temp + (temp = tempY - oldY) * temp)) - 1];
              oldX = tempX;
              oldY = tempY;
            }
            data._segments.push(total);
            data._segments.push(sublines);
            data._length += total;
          }
        } else {
          throw ("invalid 'path' data, please see documentation for valid paths");
        }
        temp = data.orient;
        data.orient = true;
        var o = {};
        MotionGuidePlugin.calc(data, data.start, o);
        tween.__rotPathS = Number(o.rotation.toFixed(5));
        MotionGuidePlugin.calc(data, data.end, o);
        tween.__rotPathE = Number(o.rotation.toFixed(5));
        data.orient = false;
        MotionGuidePlugin.calc(data, data.end, injectProps);
        data.orient = temp;
        if (!data.orient) {
          return endValue;
        }
        tween.__guideData = data;
        MotionGuidePlugin.testRotData(tween, injectProps);
        return endValue;
      };
      MotionGuidePlugin.testRotData = function(tween, injectProps) {
        if (tween.__rotGlobalS === undefined || tween.__rotGlobalE === undefined) {
          if (tween.__needsRot) {
            return;
          }
          if (tween._curQueueProps.rotation !== undefined) {
            tween.__rotGlobalS = tween.__rotGlobalE = tween._curQueueProps.rotation;
          } else {
            tween.__rotGlobalS = tween.__rotGlobalE = injectProps.rotation = tween.target.rotation || 0;
          }
        }
        if (tween.__guideData === undefined) {
          return;
        }
        var data = tween.__guideData;
        var rotGlobalD = tween.__rotGlobalE - tween.__rotGlobalS;
        var rotPathD = tween.__rotPathE - tween.__rotPathS;
        var rot = rotGlobalD - rotPathD;
        if (data.orient == "auto") {
          if (rot > 180) {
            rot -= 360;
          } else if (rot < -180) {
            rot += 360;
          }
        } else if (data.orient == "cw") {
          while (rot < 0) {
            rot += 360;
          }
          if (rot == 0 && rotGlobalD > 0 && rotGlobalD != 180) {
            rot += 360;
          }
        } else if (data.orient == "ccw") {
          rot = rotGlobalD - ((rotPathD > 180) ? (360 - rotPathD) : (rotPathD));
          while (rot > 0) {
            rot -= 360;
          }
          if (rot == 0 && rotGlobalD < 0 && rotGlobalD != -180) {
            rot -= 360;
          }
        }
        data.rotDelta = rot;
        data.rotOffS = tween.__rotGlobalS - tween.__rotPathS;
        tween.__rotGlobalS = tween.__rotGlobalE = tween.__guideData = tween.__needsRot = undefined;
      };
      MotionGuidePlugin.tween = function(tween, prop, value, startValues, endValues, ratio, wait, end) {
        var data = endValues.guide;
        if (data == undefined || data === startValues.guide) {
          return value;
        }
        if (data.lastRatio != ratio) {
          var t = ((data.end - data.start) * (wait ? data.end : ratio) + data.start);
          MotionGuidePlugin.calc(data, t, tween.target);
          switch (data.orient) {
            case "cw":
            case "ccw":
            case "auto":
              tween.target.rotation += data.rotOffS + data.rotDelta * ratio;
              break;
            case "fixed":
            default:
              tween.target.rotation += data.rotOffS;
              break;
          }
          data.lastRatio = ratio;
        }
        if (prop == "rotation" && ((!data.orient) || data.orient == "false")) {
          return value;
        }
        return tween.target[prop];
      };
      MotionGuidePlugin.calc = function(data, ratio, target) {
        if (data._segments == undefined) {
          MotionGuidePlugin.validate(data);
        }
        if (target == undefined) {
          target = {
            x: 0,
            y: 0,
            rotation: 0
          };
        }
        var seg = data._segments;
        var path = data.path;
        var pos = data._length * ratio;
        var cap = seg.length - 2;
        var n = 0;
        while (pos > seg[n] && n < cap) {
          pos -= seg[n];
          n += 2;
        }
        var sublines = seg[n + 1];
        var i = 0;
        cap = sublines.length - 1;
        while (pos > sublines[i] && i < cap) {
          pos -= sublines[i];
          i++;
        }
        var t = (i / ++cap) + (pos / (cap * sublines[i]));
        n = (n * 2) + 2;
        var inv = 1 - t;
        target.x = inv * inv * path[n - 2] + 2 * inv * t * path[n + 0] + t * t * path[n + 2];
        target.y = inv * inv * path[n - 1] + 2 * inv * t * path[n + 1] + t * t * path[n + 3];
        if (data.orient) {
          target.rotation = 57.2957795 * Math.atan2((path[n + 1] - path[n - 1]) * inv + (path[n + 3] - path[n + 1]) * t, (path[n + 0] - path[n - 2]) * inv + (path[n + 2] - path[n + 0]) * t);
        }
        return target;
      };
      createjs.MotionGuidePlugin = MotionGuidePlugin;
    }());
    this.createjs = this.createjs || {};
    (function() {
      "use strict";
      var s = createjs.TweenJS = createjs.TweenJS || {};
      s.version = "0.6.1";
      s.buildDate = "Thu, 21 May 2015 16:17:37 GMT";
    })();
  })();
  return _retrieveGlobal();
});

(function() {
var _removeDefine = System.get("@@amd-helpers").createDefine();
(function(window, document, exportName, undefined) {
  'use strict';
  var VENDOR_PREFIXES = ['', 'webkit', 'moz', 'MS', 'ms', 'o'];
  var TEST_ELEMENT = document.createElement('div');
  var TYPE_FUNCTION = 'function';
  var round = Math.round;
  var abs = Math.abs;
  var now = Date.now;
  function setTimeoutContext(fn, timeout, context) {
    return setTimeout(bindFn(fn, context), timeout);
  }
  function invokeArrayArg(arg, fn, context) {
    if (Array.isArray(arg)) {
      each(arg, context[fn], context);
      return true;
    }
    return false;
  }
  function each(obj, iterator, context) {
    var i;
    if (!obj) {
      return;
    }
    if (obj.forEach) {
      obj.forEach(iterator, context);
    } else if (obj.length !== undefined) {
      i = 0;
      while (i < obj.length) {
        iterator.call(context, obj[i], i, obj);
        i++;
      }
    } else {
      for (i in obj) {
        obj.hasOwnProperty(i) && iterator.call(context, obj[i], i, obj);
      }
    }
  }
  function extend(dest, src, merge) {
    var keys = Object.keys(src);
    var i = 0;
    while (i < keys.length) {
      if (!merge || (merge && dest[keys[i]] === undefined)) {
        dest[keys[i]] = src[keys[i]];
      }
      i++;
    }
    return dest;
  }
  function merge(dest, src) {
    return extend(dest, src, true);
  }
  function inherit(child, base, properties) {
    var baseP = base.prototype,
        childP;
    childP = child.prototype = Object.create(baseP);
    childP.constructor = child;
    childP._super = baseP;
    if (properties) {
      extend(childP, properties);
    }
  }
  function bindFn(fn, context) {
    return function boundFn() {
      return fn.apply(context, arguments);
    };
  }
  function boolOrFn(val, args) {
    if (typeof val == TYPE_FUNCTION) {
      return val.apply(args ? args[0] || undefined : undefined, args);
    }
    return val;
  }
  function ifUndefined(val1, val2) {
    return (val1 === undefined) ? val2 : val1;
  }
  function addEventListeners(target, types, handler) {
    each(splitStr(types), function(type) {
      target.addEventListener(type, handler, false);
    });
  }
  function removeEventListeners(target, types, handler) {
    each(splitStr(types), function(type) {
      target.removeEventListener(type, handler, false);
    });
  }
  function hasParent(node, parent) {
    while (node) {
      if (node == parent) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
  function inStr(str, find) {
    return str.indexOf(find) > -1;
  }
  function splitStr(str) {
    return str.trim().split(/\s+/g);
  }
  function inArray(src, find, findByKey) {
    if (src.indexOf && !findByKey) {
      return src.indexOf(find);
    } else {
      var i = 0;
      while (i < src.length) {
        if ((findByKey && src[i][findByKey] == find) || (!findByKey && src[i] === find)) {
          return i;
        }
        i++;
      }
      return -1;
    }
  }
  function toArray(obj) {
    return Array.prototype.slice.call(obj, 0);
  }
  function uniqueArray(src, key, sort) {
    var results = [];
    var values = [];
    var i = 0;
    while (i < src.length) {
      var val = key ? src[i][key] : src[i];
      if (inArray(values, val) < 0) {
        results.push(src[i]);
      }
      values[i] = val;
      i++;
    }
    if (sort) {
      if (!key) {
        results = results.sort();
      } else {
        results = results.sort(function sortUniqueArray(a, b) {
          return a[key] > b[key];
        });
      }
    }
    return results;
  }
  function prefixed(obj, property) {
    var prefix,
        prop;
    var camelProp = property[0].toUpperCase() + property.slice(1);
    var i = 0;
    while (i < VENDOR_PREFIXES.length) {
      prefix = VENDOR_PREFIXES[i];
      prop = (prefix) ? prefix + camelProp : property;
      if (prop in obj) {
        return prop;
      }
      i++;
    }
    return undefined;
  }
  var _uniqueId = 1;
  function uniqueId() {
    return _uniqueId++;
  }
  function getWindowForElement(element) {
    var doc = element.ownerDocument;
    return (doc.defaultView || doc.parentWindow);
  }
  var MOBILE_REGEX = /mobile|tablet|ip(ad|hone|od)|android/i;
  var SUPPORT_TOUCH = ('ontouchstart' in window);
  var SUPPORT_POINTER_EVENTS = prefixed(window, 'PointerEvent') !== undefined;
  var SUPPORT_ONLY_TOUCH = SUPPORT_TOUCH && MOBILE_REGEX.test(navigator.userAgent);
  var INPUT_TYPE_TOUCH = 'touch';
  var INPUT_TYPE_PEN = 'pen';
  var INPUT_TYPE_MOUSE = 'mouse';
  var INPUT_TYPE_KINECT = 'kinect';
  var COMPUTE_INTERVAL = 25;
  var INPUT_START = 1;
  var INPUT_MOVE = 2;
  var INPUT_END = 4;
  var INPUT_CANCEL = 8;
  var DIRECTION_NONE = 1;
  var DIRECTION_LEFT = 2;
  var DIRECTION_RIGHT = 4;
  var DIRECTION_UP = 8;
  var DIRECTION_DOWN = 16;
  var DIRECTION_HORIZONTAL = DIRECTION_LEFT | DIRECTION_RIGHT;
  var DIRECTION_VERTICAL = DIRECTION_UP | DIRECTION_DOWN;
  var DIRECTION_ALL = DIRECTION_HORIZONTAL | DIRECTION_VERTICAL;
  var PROPS_XY = ['x', 'y'];
  var PROPS_CLIENT_XY = ['clientX', 'clientY'];
  function Input(manager, callback) {
    var self = this;
    this.manager = manager;
    this.callback = callback;
    this.element = manager.element;
    this.target = manager.options.inputTarget;
    this.domHandler = function(ev) {
      if (boolOrFn(manager.options.enable, [manager])) {
        self.handler(ev);
      }
    };
    this.init();
  }
  Input.prototype = {
    handler: function() {},
    init: function() {
      this.evEl && addEventListeners(this.element, this.evEl, this.domHandler);
      this.evTarget && addEventListeners(this.target, this.evTarget, this.domHandler);
      this.evWin && addEventListeners(getWindowForElement(this.element), this.evWin, this.domHandler);
    },
    destroy: function() {
      this.evEl && removeEventListeners(this.element, this.evEl, this.domHandler);
      this.evTarget && removeEventListeners(this.target, this.evTarget, this.domHandler);
      this.evWin && removeEventListeners(getWindowForElement(this.element), this.evWin, this.domHandler);
    }
  };
  function createInputInstance(manager) {
    var Type;
    var inputClass = manager.options.inputClass;
    if (inputClass) {
      Type = inputClass;
    } else if (SUPPORT_POINTER_EVENTS) {
      Type = PointerEventInput;
    } else if (SUPPORT_ONLY_TOUCH) {
      Type = TouchInput;
    } else if (!SUPPORT_TOUCH) {
      Type = MouseInput;
    } else {
      Type = TouchMouseInput;
    }
    return new (Type)(manager, inputHandler);
  }
  function inputHandler(manager, eventType, input) {
    var pointersLen = input.pointers.length;
    var changedPointersLen = input.changedPointers.length;
    var isFirst = (eventType & INPUT_START && (pointersLen - changedPointersLen === 0));
    var isFinal = (eventType & (INPUT_END | INPUT_CANCEL) && (pointersLen - changedPointersLen === 0));
    input.isFirst = !!isFirst;
    input.isFinal = !!isFinal;
    if (isFirst) {
      manager.session = {};
    }
    input.eventType = eventType;
    computeInputData(manager, input);
    manager.emit('hammer.input', input);
    manager.recognize(input);
    manager.session.prevInput = input;
  }
  function computeInputData(manager, input) {
    var session = manager.session;
    var pointers = input.pointers;
    var pointersLength = pointers.length;
    if (!session.firstInput) {
      session.firstInput = simpleCloneInputData(input);
    }
    if (pointersLength > 1 && !session.firstMultiple) {
      session.firstMultiple = simpleCloneInputData(input);
    } else if (pointersLength === 1) {
      session.firstMultiple = false;
    }
    var firstInput = session.firstInput;
    var firstMultiple = session.firstMultiple;
    var offsetCenter = firstMultiple ? firstMultiple.center : firstInput.center;
    var center = input.center = getCenter(pointers);
    input.timeStamp = now();
    input.deltaTime = input.timeStamp - firstInput.timeStamp;
    input.angle = getAngle(offsetCenter, center);
    input.distance = getDistance(offsetCenter, center);
    computeDeltaXY(session, input);
    input.offsetDirection = getDirection(input.deltaX, input.deltaY);
    input.scale = firstMultiple ? getScale(firstMultiple.pointers, pointers) : 1;
    input.rotation = firstMultiple ? getRotation(firstMultiple.pointers, pointers) : 0;
    computeIntervalInputData(session, input);
    var target = manager.element;
    if (hasParent(input.srcEvent.target, target)) {
      target = input.srcEvent.target;
    }
    input.target = target;
  }
  function computeDeltaXY(session, input) {
    var center = input.center;
    var offset = session.offsetDelta || {};
    var prevDelta = session.prevDelta || {};
    var prevInput = session.prevInput || {};
    if (input.eventType === INPUT_START || prevInput.eventType === INPUT_END) {
      prevDelta = session.prevDelta = {
        x: prevInput.deltaX || 0,
        y: prevInput.deltaY || 0
      };
      offset = session.offsetDelta = {
        x: center.x,
        y: center.y
      };
    }
    input.deltaX = prevDelta.x + (center.x - offset.x);
    input.deltaY = prevDelta.y + (center.y - offset.y);
  }
  function computeIntervalInputData(session, input) {
    var last = session.lastInterval || input,
        deltaTime = input.timeStamp - last.timeStamp,
        velocity,
        velocityX,
        velocityY,
        direction;
    if (input.eventType != INPUT_CANCEL && (deltaTime > COMPUTE_INTERVAL || last.velocity === undefined)) {
      var deltaX = last.deltaX - input.deltaX;
      var deltaY = last.deltaY - input.deltaY;
      var v = getVelocity(deltaTime, deltaX, deltaY);
      velocityX = v.x;
      velocityY = v.y;
      velocity = (abs(v.x) > abs(v.y)) ? v.x : v.y;
      direction = getDirection(deltaX, deltaY);
      session.lastInterval = input;
    } else {
      velocity = last.velocity;
      velocityX = last.velocityX;
      velocityY = last.velocityY;
      direction = last.direction;
    }
    input.velocity = velocity;
    input.velocityX = velocityX;
    input.velocityY = velocityY;
    input.direction = direction;
  }
  function simpleCloneInputData(input) {
    var pointers = [];
    var i = 0;
    while (i < input.pointers.length) {
      pointers[i] = {
        clientX: round(input.pointers[i].clientX),
        clientY: round(input.pointers[i].clientY)
      };
      i++;
    }
    return {
      timeStamp: now(),
      pointers: pointers,
      center: getCenter(pointers),
      deltaX: input.deltaX,
      deltaY: input.deltaY
    };
  }
  function getCenter(pointers) {
    var pointersLength = pointers.length;
    if (pointersLength === 1) {
      return {
        x: round(pointers[0].clientX),
        y: round(pointers[0].clientY)
      };
    }
    var x = 0,
        y = 0,
        i = 0;
    while (i < pointersLength) {
      x += pointers[i].clientX;
      y += pointers[i].clientY;
      i++;
    }
    return {
      x: round(x / pointersLength),
      y: round(y / pointersLength)
    };
  }
  function getVelocity(deltaTime, x, y) {
    return {
      x: x / deltaTime || 0,
      y: y / deltaTime || 0
    };
  }
  function getDirection(x, y) {
    if (x === y) {
      return DIRECTION_NONE;
    }
    if (abs(x) >= abs(y)) {
      return x > 0 ? DIRECTION_LEFT : DIRECTION_RIGHT;
    }
    return y > 0 ? DIRECTION_UP : DIRECTION_DOWN;
  }
  function getDistance(p1, p2, props) {
    if (!props) {
      props = PROPS_XY;
    }
    var x = p2[props[0]] - p1[props[0]],
        y = p2[props[1]] - p1[props[1]];
    return Math.sqrt((x * x) + (y * y));
  }
  function getAngle(p1, p2, props) {
    if (!props) {
      props = PROPS_XY;
    }
    var x = p2[props[0]] - p1[props[0]],
        y = p2[props[1]] - p1[props[1]];
    return Math.atan2(y, x) * 180 / Math.PI;
  }
  function getRotation(start, end) {
    return getAngle(end[1], end[0], PROPS_CLIENT_XY) - getAngle(start[1], start[0], PROPS_CLIENT_XY);
  }
  function getScale(start, end) {
    return getDistance(end[0], end[1], PROPS_CLIENT_XY) / getDistance(start[0], start[1], PROPS_CLIENT_XY);
  }
  var MOUSE_INPUT_MAP = {
    mousedown: INPUT_START,
    mousemove: INPUT_MOVE,
    mouseup: INPUT_END
  };
  var MOUSE_ELEMENT_EVENTS = 'mousedown';
  var MOUSE_WINDOW_EVENTS = 'mousemove mouseup';
  function MouseInput() {
    this.evEl = MOUSE_ELEMENT_EVENTS;
    this.evWin = MOUSE_WINDOW_EVENTS;
    this.allow = true;
    this.pressed = false;
    Input.apply(this, arguments);
  }
  inherit(MouseInput, Input, {handler: function MEhandler(ev) {
      var eventType = MOUSE_INPUT_MAP[ev.type];
      if (eventType & INPUT_START && ev.button === 0) {
        this.pressed = true;
      }
      if (eventType & INPUT_MOVE && ev.which !== 1) {
        eventType = INPUT_END;
      }
      if (!this.pressed || !this.allow) {
        return;
      }
      if (eventType & INPUT_END) {
        this.pressed = false;
      }
      this.callback(this.manager, eventType, {
        pointers: [ev],
        changedPointers: [ev],
        pointerType: INPUT_TYPE_MOUSE,
        srcEvent: ev
      });
    }});
  var POINTER_INPUT_MAP = {
    pointerdown: INPUT_START,
    pointermove: INPUT_MOVE,
    pointerup: INPUT_END,
    pointercancel: INPUT_CANCEL,
    pointerout: INPUT_CANCEL
  };
  var IE10_POINTER_TYPE_ENUM = {
    2: INPUT_TYPE_TOUCH,
    3: INPUT_TYPE_PEN,
    4: INPUT_TYPE_MOUSE,
    5: INPUT_TYPE_KINECT
  };
  var POINTER_ELEMENT_EVENTS = 'pointerdown';
  var POINTER_WINDOW_EVENTS = 'pointermove pointerup pointercancel';
  if (window.MSPointerEvent) {
    POINTER_ELEMENT_EVENTS = 'MSPointerDown';
    POINTER_WINDOW_EVENTS = 'MSPointerMove MSPointerUp MSPointerCancel';
  }
  function PointerEventInput() {
    this.evEl = POINTER_ELEMENT_EVENTS;
    this.evWin = POINTER_WINDOW_EVENTS;
    Input.apply(this, arguments);
    this.store = (this.manager.session.pointerEvents = []);
  }
  inherit(PointerEventInput, Input, {handler: function PEhandler(ev) {
      var store = this.store;
      var removePointer = false;
      var eventTypeNormalized = ev.type.toLowerCase().replace('ms', '');
      var eventType = POINTER_INPUT_MAP[eventTypeNormalized];
      var pointerType = IE10_POINTER_TYPE_ENUM[ev.pointerType] || ev.pointerType;
      var isTouch = (pointerType == INPUT_TYPE_TOUCH);
      var storeIndex = inArray(store, ev.pointerId, 'pointerId');
      if (eventType & INPUT_START && (ev.button === 0 || isTouch)) {
        if (storeIndex < 0) {
          store.push(ev);
          storeIndex = store.length - 1;
        }
      } else if (eventType & (INPUT_END | INPUT_CANCEL)) {
        removePointer = true;
      }
      if (storeIndex < 0) {
        return;
      }
      store[storeIndex] = ev;
      this.callback(this.manager, eventType, {
        pointers: store,
        changedPointers: [ev],
        pointerType: pointerType,
        srcEvent: ev
      });
      if (removePointer) {
        store.splice(storeIndex, 1);
      }
    }});
  var SINGLE_TOUCH_INPUT_MAP = {
    touchstart: INPUT_START,
    touchmove: INPUT_MOVE,
    touchend: INPUT_END,
    touchcancel: INPUT_CANCEL
  };
  var SINGLE_TOUCH_TARGET_EVENTS = 'touchstart';
  var SINGLE_TOUCH_WINDOW_EVENTS = 'touchstart touchmove touchend touchcancel';
  function SingleTouchInput() {
    this.evTarget = SINGLE_TOUCH_TARGET_EVENTS;
    this.evWin = SINGLE_TOUCH_WINDOW_EVENTS;
    this.started = false;
    Input.apply(this, arguments);
  }
  inherit(SingleTouchInput, Input, {handler: function TEhandler(ev) {
      var type = SINGLE_TOUCH_INPUT_MAP[ev.type];
      if (type === INPUT_START) {
        this.started = true;
      }
      if (!this.started) {
        return;
      }
      var touches = normalizeSingleTouches.call(this, ev, type);
      if (type & (INPUT_END | INPUT_CANCEL) && touches[0].length - touches[1].length === 0) {
        this.started = false;
      }
      this.callback(this.manager, type, {
        pointers: touches[0],
        changedPointers: touches[1],
        pointerType: INPUT_TYPE_TOUCH,
        srcEvent: ev
      });
    }});
  function normalizeSingleTouches(ev, type) {
    var all = toArray(ev.touches);
    var changed = toArray(ev.changedTouches);
    if (type & (INPUT_END | INPUT_CANCEL)) {
      all = uniqueArray(all.concat(changed), 'identifier', true);
    }
    return [all, changed];
  }
  var TOUCH_INPUT_MAP = {
    touchstart: INPUT_START,
    touchmove: INPUT_MOVE,
    touchend: INPUT_END,
    touchcancel: INPUT_CANCEL
  };
  var TOUCH_TARGET_EVENTS = 'touchstart touchmove touchend touchcancel';
  function TouchInput() {
    this.evTarget = TOUCH_TARGET_EVENTS;
    this.targetIds = {};
    Input.apply(this, arguments);
  }
  inherit(TouchInput, Input, {handler: function MTEhandler(ev) {
      var type = TOUCH_INPUT_MAP[ev.type];
      var touches = getTouches.call(this, ev, type);
      if (!touches) {
        return;
      }
      this.callback(this.manager, type, {
        pointers: touches[0],
        changedPointers: touches[1],
        pointerType: INPUT_TYPE_TOUCH,
        srcEvent: ev
      });
    }});
  function getTouches(ev, type) {
    var allTouches = toArray(ev.touches);
    var targetIds = this.targetIds;
    if (type & (INPUT_START | INPUT_MOVE) && allTouches.length === 1) {
      targetIds[allTouches[0].identifier] = true;
      return [allTouches, allTouches];
    }
    var i,
        targetTouches,
        changedTouches = toArray(ev.changedTouches),
        changedTargetTouches = [],
        target = this.target;
    targetTouches = allTouches.filter(function(touch) {
      return hasParent(touch.target, target);
    });
    if (type === INPUT_START) {
      i = 0;
      while (i < targetTouches.length) {
        targetIds[targetTouches[i].identifier] = true;
        i++;
      }
    }
    i = 0;
    while (i < changedTouches.length) {
      if (targetIds[changedTouches[i].identifier]) {
        changedTargetTouches.push(changedTouches[i]);
      }
      if (type & (INPUT_END | INPUT_CANCEL)) {
        delete targetIds[changedTouches[i].identifier];
      }
      i++;
    }
    if (!changedTargetTouches.length) {
      return;
    }
    return [uniqueArray(targetTouches.concat(changedTargetTouches), 'identifier', true), changedTargetTouches];
  }
  function TouchMouseInput() {
    Input.apply(this, arguments);
    var handler = bindFn(this.handler, this);
    this.touch = new TouchInput(this.manager, handler);
    this.mouse = new MouseInput(this.manager, handler);
  }
  inherit(TouchMouseInput, Input, {
    handler: function TMEhandler(manager, inputEvent, inputData) {
      var isTouch = (inputData.pointerType == INPUT_TYPE_TOUCH),
          isMouse = (inputData.pointerType == INPUT_TYPE_MOUSE);
      if (isTouch) {
        this.mouse.allow = false;
      } else if (isMouse && !this.mouse.allow) {
        return;
      }
      if (inputEvent & (INPUT_END | INPUT_CANCEL)) {
        this.mouse.allow = true;
      }
      this.callback(manager, inputEvent, inputData);
    },
    destroy: function destroy() {
      this.touch.destroy();
      this.mouse.destroy();
    }
  });
  var PREFIXED_TOUCH_ACTION = prefixed(TEST_ELEMENT.style, 'touchAction');
  var NATIVE_TOUCH_ACTION = PREFIXED_TOUCH_ACTION !== undefined;
  var TOUCH_ACTION_COMPUTE = 'compute';
  var TOUCH_ACTION_AUTO = 'auto';
  var TOUCH_ACTION_MANIPULATION = 'manipulation';
  var TOUCH_ACTION_NONE = 'none';
  var TOUCH_ACTION_PAN_X = 'pan-x';
  var TOUCH_ACTION_PAN_Y = 'pan-y';
  function TouchAction(manager, value) {
    this.manager = manager;
    this.set(value);
  }
  TouchAction.prototype = {
    set: function(value) {
      if (value == TOUCH_ACTION_COMPUTE) {
        value = this.compute();
      }
      if (NATIVE_TOUCH_ACTION) {
        this.manager.element.style[PREFIXED_TOUCH_ACTION] = value;
      }
      this.actions = value.toLowerCase().trim();
    },
    update: function() {
      this.set(this.manager.options.touchAction);
    },
    compute: function() {
      var actions = [];
      each(this.manager.recognizers, function(recognizer) {
        if (boolOrFn(recognizer.options.enable, [recognizer])) {
          actions = actions.concat(recognizer.getTouchAction());
        }
      });
      return cleanTouchActions(actions.join(' '));
    },
    preventDefaults: function(input) {
      if (NATIVE_TOUCH_ACTION) {
        return;
      }
      var srcEvent = input.srcEvent;
      var direction = input.offsetDirection;
      if (this.manager.session.prevented) {
        srcEvent.preventDefault();
        return;
      }
      var actions = this.actions;
      var hasNone = inStr(actions, TOUCH_ACTION_NONE);
      var hasPanY = inStr(actions, TOUCH_ACTION_PAN_Y);
      var hasPanX = inStr(actions, TOUCH_ACTION_PAN_X);
      if (hasNone || (hasPanY && direction & DIRECTION_HORIZONTAL) || (hasPanX && direction & DIRECTION_VERTICAL)) {
        return this.preventSrc(srcEvent);
      }
    },
    preventSrc: function(srcEvent) {
      this.manager.session.prevented = true;
      srcEvent.preventDefault();
    }
  };
  function cleanTouchActions(actions) {
    if (inStr(actions, TOUCH_ACTION_NONE)) {
      return TOUCH_ACTION_NONE;
    }
    var hasPanX = inStr(actions, TOUCH_ACTION_PAN_X);
    var hasPanY = inStr(actions, TOUCH_ACTION_PAN_Y);
    if (hasPanX && hasPanY) {
      return TOUCH_ACTION_PAN_X + ' ' + TOUCH_ACTION_PAN_Y;
    }
    if (hasPanX || hasPanY) {
      return hasPanX ? TOUCH_ACTION_PAN_X : TOUCH_ACTION_PAN_Y;
    }
    if (inStr(actions, TOUCH_ACTION_MANIPULATION)) {
      return TOUCH_ACTION_MANIPULATION;
    }
    return TOUCH_ACTION_AUTO;
  }
  var STATE_POSSIBLE = 1;
  var STATE_BEGAN = 2;
  var STATE_CHANGED = 4;
  var STATE_ENDED = 8;
  var STATE_RECOGNIZED = STATE_ENDED;
  var STATE_CANCELLED = 16;
  var STATE_FAILED = 32;
  function Recognizer(options) {
    this.id = uniqueId();
    this.manager = null;
    this.options = merge(options || {}, this.defaults);
    this.options.enable = ifUndefined(this.options.enable, true);
    this.state = STATE_POSSIBLE;
    this.simultaneous = {};
    this.requireFail = [];
  }
  Recognizer.prototype = {
    defaults: {},
    set: function(options) {
      extend(this.options, options);
      this.manager && this.manager.touchAction.update();
      return this;
    },
    recognizeWith: function(otherRecognizer) {
      if (invokeArrayArg(otherRecognizer, 'recognizeWith', this)) {
        return this;
      }
      var simultaneous = this.simultaneous;
      otherRecognizer = getRecognizerByNameIfManager(otherRecognizer, this);
      if (!simultaneous[otherRecognizer.id]) {
        simultaneous[otherRecognizer.id] = otherRecognizer;
        otherRecognizer.recognizeWith(this);
      }
      return this;
    },
    dropRecognizeWith: function(otherRecognizer) {
      if (invokeArrayArg(otherRecognizer, 'dropRecognizeWith', this)) {
        return this;
      }
      otherRecognizer = getRecognizerByNameIfManager(otherRecognizer, this);
      delete this.simultaneous[otherRecognizer.id];
      return this;
    },
    requireFailure: function(otherRecognizer) {
      if (invokeArrayArg(otherRecognizer, 'requireFailure', this)) {
        return this;
      }
      var requireFail = this.requireFail;
      otherRecognizer = getRecognizerByNameIfManager(otherRecognizer, this);
      if (inArray(requireFail, otherRecognizer) === -1) {
        requireFail.push(otherRecognizer);
        otherRecognizer.requireFailure(this);
      }
      return this;
    },
    dropRequireFailure: function(otherRecognizer) {
      if (invokeArrayArg(otherRecognizer, 'dropRequireFailure', this)) {
        return this;
      }
      otherRecognizer = getRecognizerByNameIfManager(otherRecognizer, this);
      var index = inArray(this.requireFail, otherRecognizer);
      if (index > -1) {
        this.requireFail.splice(index, 1);
      }
      return this;
    },
    hasRequireFailures: function() {
      return this.requireFail.length > 0;
    },
    canRecognizeWith: function(otherRecognizer) {
      return !!this.simultaneous[otherRecognizer.id];
    },
    emit: function(input) {
      var self = this;
      var state = this.state;
      function emit(withState) {
        self.manager.emit(self.options.event + (withState ? stateStr(state) : ''), input);
      }
      if (state < STATE_ENDED) {
        emit(true);
      }
      emit();
      if (state >= STATE_ENDED) {
        emit(true);
      }
    },
    tryEmit: function(input) {
      if (this.canEmit()) {
        return this.emit(input);
      }
      this.state = STATE_FAILED;
    },
    canEmit: function() {
      var i = 0;
      while (i < this.requireFail.length) {
        if (!(this.requireFail[i].state & (STATE_FAILED | STATE_POSSIBLE))) {
          return false;
        }
        i++;
      }
      return true;
    },
    recognize: function(inputData) {
      var inputDataClone = extend({}, inputData);
      if (!boolOrFn(this.options.enable, [this, inputDataClone])) {
        this.reset();
        this.state = STATE_FAILED;
        return;
      }
      if (this.state & (STATE_RECOGNIZED | STATE_CANCELLED | STATE_FAILED)) {
        this.state = STATE_POSSIBLE;
      }
      this.state = this.process(inputDataClone);
      if (this.state & (STATE_BEGAN | STATE_CHANGED | STATE_ENDED | STATE_CANCELLED)) {
        this.tryEmit(inputDataClone);
      }
    },
    process: function(inputData) {},
    getTouchAction: function() {},
    reset: function() {}
  };
  function stateStr(state) {
    if (state & STATE_CANCELLED) {
      return 'cancel';
    } else if (state & STATE_ENDED) {
      return 'end';
    } else if (state & STATE_CHANGED) {
      return 'move';
    } else if (state & STATE_BEGAN) {
      return 'start';
    }
    return '';
  }
  function directionStr(direction) {
    if (direction == DIRECTION_DOWN) {
      return 'down';
    } else if (direction == DIRECTION_UP) {
      return 'up';
    } else if (direction == DIRECTION_LEFT) {
      return 'left';
    } else if (direction == DIRECTION_RIGHT) {
      return 'right';
    }
    return '';
  }
  function getRecognizerByNameIfManager(otherRecognizer, recognizer) {
    var manager = recognizer.manager;
    if (manager) {
      return manager.get(otherRecognizer);
    }
    return otherRecognizer;
  }
  function AttrRecognizer() {
    Recognizer.apply(this, arguments);
  }
  inherit(AttrRecognizer, Recognizer, {
    defaults: {pointers: 1},
    attrTest: function(input) {
      var optionPointers = this.options.pointers;
      return optionPointers === 0 || input.pointers.length === optionPointers;
    },
    process: function(input) {
      var state = this.state;
      var eventType = input.eventType;
      var isRecognized = state & (STATE_BEGAN | STATE_CHANGED);
      var isValid = this.attrTest(input);
      if (isRecognized && (eventType & INPUT_CANCEL || !isValid)) {
        return state | STATE_CANCELLED;
      } else if (isRecognized || isValid) {
        if (eventType & INPUT_END) {
          return state | STATE_ENDED;
        } else if (!(state & STATE_BEGAN)) {
          return STATE_BEGAN;
        }
        return state | STATE_CHANGED;
      }
      return STATE_FAILED;
    }
  });
  function PanRecognizer() {
    AttrRecognizer.apply(this, arguments);
    this.pX = null;
    this.pY = null;
  }
  inherit(PanRecognizer, AttrRecognizer, {
    defaults: {
      event: 'pan',
      threshold: 10,
      pointers: 1,
      direction: DIRECTION_ALL
    },
    getTouchAction: function() {
      var direction = this.options.direction;
      var actions = [];
      if (direction & DIRECTION_HORIZONTAL) {
        actions.push(TOUCH_ACTION_PAN_Y);
      }
      if (direction & DIRECTION_VERTICAL) {
        actions.push(TOUCH_ACTION_PAN_X);
      }
      return actions;
    },
    directionTest: function(input) {
      var options = this.options;
      var hasMoved = true;
      var distance = input.distance;
      var direction = input.direction;
      var x = input.deltaX;
      var y = input.deltaY;
      if (!(direction & options.direction)) {
        if (options.direction & DIRECTION_HORIZONTAL) {
          direction = (x === 0) ? DIRECTION_NONE : (x < 0) ? DIRECTION_LEFT : DIRECTION_RIGHT;
          hasMoved = x != this.pX;
          distance = Math.abs(input.deltaX);
        } else {
          direction = (y === 0) ? DIRECTION_NONE : (y < 0) ? DIRECTION_UP : DIRECTION_DOWN;
          hasMoved = y != this.pY;
          distance = Math.abs(input.deltaY);
        }
      }
      input.direction = direction;
      return hasMoved && distance > options.threshold && direction & options.direction;
    },
    attrTest: function(input) {
      return AttrRecognizer.prototype.attrTest.call(this, input) && (this.state & STATE_BEGAN || (!(this.state & STATE_BEGAN) && this.directionTest(input)));
    },
    emit: function(input) {
      this.pX = input.deltaX;
      this.pY = input.deltaY;
      var direction = directionStr(input.direction);
      if (direction) {
        this.manager.emit(this.options.event + direction, input);
      }
      this._super.emit.call(this, input);
    }
  });
  function PinchRecognizer() {
    AttrRecognizer.apply(this, arguments);
  }
  inherit(PinchRecognizer, AttrRecognizer, {
    defaults: {
      event: 'pinch',
      threshold: 0,
      pointers: 2
    },
    getTouchAction: function() {
      return [TOUCH_ACTION_NONE];
    },
    attrTest: function(input) {
      return this._super.attrTest.call(this, input) && (Math.abs(input.scale - 1) > this.options.threshold || this.state & STATE_BEGAN);
    },
    emit: function(input) {
      this._super.emit.call(this, input);
      if (input.scale !== 1) {
        var inOut = input.scale < 1 ? 'in' : 'out';
        this.manager.emit(this.options.event + inOut, input);
      }
    }
  });
  function PressRecognizer() {
    Recognizer.apply(this, arguments);
    this._timer = null;
    this._input = null;
  }
  inherit(PressRecognizer, Recognizer, {
    defaults: {
      event: 'press',
      pointers: 1,
      time: 500,
      threshold: 5
    },
    getTouchAction: function() {
      return [TOUCH_ACTION_AUTO];
    },
    process: function(input) {
      var options = this.options;
      var validPointers = input.pointers.length === options.pointers;
      var validMovement = input.distance < options.threshold;
      var validTime = input.deltaTime > options.time;
      this._input = input;
      if (!validMovement || !validPointers || (input.eventType & (INPUT_END | INPUT_CANCEL) && !validTime)) {
        this.reset();
      } else if (input.eventType & INPUT_START) {
        this.reset();
        this._timer = setTimeoutContext(function() {
          this.state = STATE_RECOGNIZED;
          this.tryEmit();
        }, options.time, this);
      } else if (input.eventType & INPUT_END) {
        return STATE_RECOGNIZED;
      }
      return STATE_FAILED;
    },
    reset: function() {
      clearTimeout(this._timer);
    },
    emit: function(input) {
      if (this.state !== STATE_RECOGNIZED) {
        return;
      }
      if (input && (input.eventType & INPUT_END)) {
        this.manager.emit(this.options.event + 'up', input);
      } else {
        this._input.timeStamp = now();
        this.manager.emit(this.options.event, this._input);
      }
    }
  });
  function RotateRecognizer() {
    AttrRecognizer.apply(this, arguments);
  }
  inherit(RotateRecognizer, AttrRecognizer, {
    defaults: {
      event: 'rotate',
      threshold: 0,
      pointers: 2
    },
    getTouchAction: function() {
      return [TOUCH_ACTION_NONE];
    },
    attrTest: function(input) {
      return this._super.attrTest.call(this, input) && (Math.abs(input.rotation) > this.options.threshold || this.state & STATE_BEGAN);
    }
  });
  function SwipeRecognizer() {
    AttrRecognizer.apply(this, arguments);
  }
  inherit(SwipeRecognizer, AttrRecognizer, {
    defaults: {
      event: 'swipe',
      threshold: 10,
      velocity: 0.65,
      direction: DIRECTION_HORIZONTAL | DIRECTION_VERTICAL,
      pointers: 1
    },
    getTouchAction: function() {
      return PanRecognizer.prototype.getTouchAction.call(this);
    },
    attrTest: function(input) {
      var direction = this.options.direction;
      var velocity;
      if (direction & (DIRECTION_HORIZONTAL | DIRECTION_VERTICAL)) {
        velocity = input.velocity;
      } else if (direction & DIRECTION_HORIZONTAL) {
        velocity = input.velocityX;
      } else if (direction & DIRECTION_VERTICAL) {
        velocity = input.velocityY;
      }
      return this._super.attrTest.call(this, input) && direction & input.direction && input.distance > this.options.threshold && abs(velocity) > this.options.velocity && input.eventType & INPUT_END;
    },
    emit: function(input) {
      var direction = directionStr(input.direction);
      if (direction) {
        this.manager.emit(this.options.event + direction, input);
      }
      this.manager.emit(this.options.event, input);
    }
  });
  function TapRecognizer() {
    Recognizer.apply(this, arguments);
    this.pTime = false;
    this.pCenter = false;
    this._timer = null;
    this._input = null;
    this.count = 0;
  }
  inherit(TapRecognizer, Recognizer, {
    defaults: {
      event: 'tap',
      pointers: 1,
      taps: 1,
      interval: 300,
      time: 250,
      threshold: 2,
      posThreshold: 10
    },
    getTouchAction: function() {
      return [TOUCH_ACTION_MANIPULATION];
    },
    process: function(input) {
      var options = this.options;
      var validPointers = input.pointers.length === options.pointers;
      var validMovement = input.distance < options.threshold;
      var validTouchTime = input.deltaTime < options.time;
      this.reset();
      if ((input.eventType & INPUT_START) && (this.count === 0)) {
        return this.failTimeout();
      }
      if (validMovement && validTouchTime && validPointers) {
        if (input.eventType != INPUT_END) {
          return this.failTimeout();
        }
        var validInterval = this.pTime ? (input.timeStamp - this.pTime < options.interval) : true;
        var validMultiTap = !this.pCenter || getDistance(this.pCenter, input.center) < options.posThreshold;
        this.pTime = input.timeStamp;
        this.pCenter = input.center;
        if (!validMultiTap || !validInterval) {
          this.count = 1;
        } else {
          this.count += 1;
        }
        this._input = input;
        var tapCount = this.count % options.taps;
        if (tapCount === 0) {
          if (!this.hasRequireFailures()) {
            return STATE_RECOGNIZED;
          } else {
            this._timer = setTimeoutContext(function() {
              this.state = STATE_RECOGNIZED;
              this.tryEmit();
            }, options.interval, this);
            return STATE_BEGAN;
          }
        }
      }
      return STATE_FAILED;
    },
    failTimeout: function() {
      this._timer = setTimeoutContext(function() {
        this.state = STATE_FAILED;
      }, this.options.interval, this);
      return STATE_FAILED;
    },
    reset: function() {
      clearTimeout(this._timer);
    },
    emit: function() {
      if (this.state == STATE_RECOGNIZED) {
        this._input.tapCount = this.count;
        this.manager.emit(this.options.event, this._input);
      }
    }
  });
  function Hammer(element, options) {
    options = options || {};
    options.recognizers = ifUndefined(options.recognizers, Hammer.defaults.preset);
    return new Manager(element, options);
  }
  Hammer.VERSION = '2.0.4';
  Hammer.defaults = {
    domEvents: false,
    touchAction: TOUCH_ACTION_COMPUTE,
    enable: true,
    inputTarget: null,
    inputClass: null,
    preset: [[RotateRecognizer, {enable: false}], [PinchRecognizer, {enable: false}, ['rotate']], [SwipeRecognizer, {direction: DIRECTION_HORIZONTAL}], [PanRecognizer, {direction: DIRECTION_HORIZONTAL}, ['swipe']], [TapRecognizer], [TapRecognizer, {
      event: 'doubletap',
      taps: 2
    }, ['tap']], [PressRecognizer]],
    cssProps: {
      userSelect: 'none',
      touchSelect: 'none',
      touchCallout: 'none',
      contentZooming: 'none',
      userDrag: 'none',
      tapHighlightColor: 'rgba(0,0,0,0)'
    }
  };
  var STOP = 1;
  var FORCED_STOP = 2;
  function Manager(element, options) {
    options = options || {};
    this.options = merge(options, Hammer.defaults);
    this.options.inputTarget = this.options.inputTarget || element;
    this.handlers = {};
    this.session = {};
    this.recognizers = [];
    this.element = element;
    this.input = createInputInstance(this);
    this.touchAction = new TouchAction(this, this.options.touchAction);
    toggleCssProps(this, true);
    each(options.recognizers, function(item) {
      var recognizer = this.add(new (item[0])(item[1]));
      item[2] && recognizer.recognizeWith(item[2]);
      item[3] && recognizer.requireFailure(item[3]);
    }, this);
  }
  Manager.prototype = {
    set: function(options) {
      extend(this.options, options);
      if (options.touchAction) {
        this.touchAction.update();
      }
      if (options.inputTarget) {
        this.input.destroy();
        this.input.target = options.inputTarget;
        this.input.init();
      }
      return this;
    },
    stop: function(force) {
      this.session.stopped = force ? FORCED_STOP : STOP;
    },
    recognize: function(inputData) {
      var session = this.session;
      if (session.stopped) {
        return;
      }
      this.touchAction.preventDefaults(inputData);
      var recognizer;
      var recognizers = this.recognizers;
      var curRecognizer = session.curRecognizer;
      if (!curRecognizer || (curRecognizer && curRecognizer.state & STATE_RECOGNIZED)) {
        curRecognizer = session.curRecognizer = null;
      }
      var i = 0;
      while (i < recognizers.length) {
        recognizer = recognizers[i];
        if (session.stopped !== FORCED_STOP && (!curRecognizer || recognizer == curRecognizer || recognizer.canRecognizeWith(curRecognizer))) {
          recognizer.recognize(inputData);
        } else {
          recognizer.reset();
        }
        if (!curRecognizer && recognizer.state & (STATE_BEGAN | STATE_CHANGED | STATE_ENDED)) {
          curRecognizer = session.curRecognizer = recognizer;
        }
        i++;
      }
    },
    get: function(recognizer) {
      if (recognizer instanceof Recognizer) {
        return recognizer;
      }
      var recognizers = this.recognizers;
      for (var i = 0; i < recognizers.length; i++) {
        if (recognizers[i].options.event == recognizer) {
          return recognizers[i];
        }
      }
      return null;
    },
    add: function(recognizer) {
      if (invokeArrayArg(recognizer, 'add', this)) {
        return this;
      }
      var existing = this.get(recognizer.options.event);
      if (existing) {
        this.remove(existing);
      }
      this.recognizers.push(recognizer);
      recognizer.manager = this;
      this.touchAction.update();
      return recognizer;
    },
    remove: function(recognizer) {
      if (invokeArrayArg(recognizer, 'remove', this)) {
        return this;
      }
      var recognizers = this.recognizers;
      recognizer = this.get(recognizer);
      recognizers.splice(inArray(recognizers, recognizer), 1);
      this.touchAction.update();
      return this;
    },
    on: function(events, handler) {
      var handlers = this.handlers;
      each(splitStr(events), function(event) {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
      });
      return this;
    },
    off: function(events, handler) {
      var handlers = this.handlers;
      each(splitStr(events), function(event) {
        if (!handler) {
          delete handlers[event];
        } else {
          handlers[event].splice(inArray(handlers[event], handler), 1);
        }
      });
      return this;
    },
    emit: function(event, data) {
      if (this.options.domEvents) {
        triggerDomEvent(event, data);
      }
      var handlers = this.handlers[event] && this.handlers[event].slice();
      if (!handlers || !handlers.length) {
        return;
      }
      data.type = event;
      data.preventDefault = function() {
        data.srcEvent.preventDefault();
      };
      var i = 0;
      while (i < handlers.length) {
        handlers[i](data);
        i++;
      }
    },
    destroy: function() {
      this.element && toggleCssProps(this, false);
      this.handlers = {};
      this.session = {};
      this.input.destroy();
      this.element = null;
    }
  };
  function toggleCssProps(manager, add) {
    var element = manager.element;
    each(manager.options.cssProps, function(value, name) {
      element.style[prefixed(element.style, name)] = add ? value : '';
    });
  }
  function triggerDomEvent(event, data) {
    var gestureEvent = document.createEvent('Event');
    gestureEvent.initEvent(event, true, true);
    gestureEvent.gesture = data;
    data.target.dispatchEvent(gestureEvent);
  }
  extend(Hammer, {
    INPUT_START: INPUT_START,
    INPUT_MOVE: INPUT_MOVE,
    INPUT_END: INPUT_END,
    INPUT_CANCEL: INPUT_CANCEL,
    STATE_POSSIBLE: STATE_POSSIBLE,
    STATE_BEGAN: STATE_BEGAN,
    STATE_CHANGED: STATE_CHANGED,
    STATE_ENDED: STATE_ENDED,
    STATE_RECOGNIZED: STATE_RECOGNIZED,
    STATE_CANCELLED: STATE_CANCELLED,
    STATE_FAILED: STATE_FAILED,
    DIRECTION_NONE: DIRECTION_NONE,
    DIRECTION_LEFT: DIRECTION_LEFT,
    DIRECTION_RIGHT: DIRECTION_RIGHT,
    DIRECTION_UP: DIRECTION_UP,
    DIRECTION_DOWN: DIRECTION_DOWN,
    DIRECTION_HORIZONTAL: DIRECTION_HORIZONTAL,
    DIRECTION_VERTICAL: DIRECTION_VERTICAL,
    DIRECTION_ALL: DIRECTION_ALL,
    Manager: Manager,
    Input: Input,
    TouchAction: TouchAction,
    TouchInput: TouchInput,
    MouseInput: MouseInput,
    PointerEventInput: PointerEventInput,
    TouchMouseInput: TouchMouseInput,
    SingleTouchInput: SingleTouchInput,
    Recognizer: Recognizer,
    AttrRecognizer: AttrRecognizer,
    Tap: TapRecognizer,
    Pan: PanRecognizer,
    Swipe: SwipeRecognizer,
    Pinch: PinchRecognizer,
    Rotate: RotateRecognizer,
    Press: PressRecognizer,
    on: addEventListeners,
    off: removeEventListeners,
    each: each,
    merge: merge,
    extend: extend,
    inherit: inherit,
    bindFn: bindFn,
    prefixed: prefixed
  });
  if (typeof define == TYPE_FUNCTION && define.amd) {
    define("github:hammerjs/hammer.js@2.0.4/hammer.js", [], function() {
      return Hammer;
    });
  } else if (typeof module != 'undefined' && module.exports) {
    module.exports = Hammer;
  } else {
    window[exportName] = Hammer;
  }
})(window, document, 'Hammer');

_removeDefine();
})();
System.registerDynamic("npm:core-js@0.9.18/library/modules/$.js", ["npm:core-js@0.9.18/library/modules/$.fw.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.18/library/modules/$.fw.js")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.registerDynamic("github:CreateJS/EaselJS@0.8.1.js", ["github:CreateJS/EaselJS@0.8.1/lib/easeljs-0.8.1.combined.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:CreateJS/EaselJS@0.8.1/lib/easeljs-0.8.1.combined.js");
  global.define = __define;
  return module.exports;
});

System.registerDynamic("github:CreateJS/TweenJS@0.6.1.js", ["github:CreateJS/TweenJS@0.6.1/lib/tweenjs-0.6.1.combined.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:CreateJS/TweenJS@0.6.1/lib/tweenjs-0.6.1.combined.js");
  global.define = __define;
  return module.exports;
});

(function() {
var _removeDefine = System.get("@@amd-helpers").createDefine();
define("github:hammerjs/hammer.js@2.0.4.js", ["github:hammerjs/hammer.js@2.0.4/hammer.js"], function(main) {
  return main;
});

_removeDefine();
})();
System.registerDynamic("npm:core-js@0.9.18/library/fn/object/define-property.js", ["npm:core-js@0.9.18/library/modules/$.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$.js");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

System.registerDynamic("npm:babel-runtime@5.6.17/core-js/object/define-property.js", ["npm:core-js@0.9.18/library/fn/object/define-property.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/define-property.js"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.registerDynamic("npm:babel-runtime@5.6.17/helpers/create-class.js", ["npm:babel-runtime@5.6.17/core-js/object/define-property.js"], true, function(require, exports, module) {
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.6.17/core-js/object/define-property.js")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("src/Hotspot.js", ["npm:babel-runtime@5.6.17/helpers/create-class.js", "npm:babel-runtime@5.6.17/helpers/class-call-check.js", "github:hammerjs/hammer.js@2.0.4.js"], function (_export) {
    var _createClass, _classCallCheck, Hammer, Hotspot;

    return {
        setters: [function (_npmBabelRuntime5617HelpersCreateClassJs) {
            _createClass = _npmBabelRuntime5617HelpersCreateClassJs["default"];
        }, function (_npmBabelRuntime5617HelpersClassCallCheckJs) {
            _classCallCheck = _npmBabelRuntime5617HelpersClassCallCheckJs["default"];
        }, function (_githubHammerjsHammerJs204Js) {
            Hammer = _githubHammerjsHammerJs204Js;
        }],
        execute: function () {
            "use strict";

            Hotspot = (function () {
                function Hotspot(picture) {
                    var _this = this;

                    _classCallCheck(this, Hotspot);

                    this.container = new createjs.Container();
                    var bitmap = this.createBitmap(picture);
                    var shape = this.createShape(bitmap);

                    this.container.on("mousedown", function () {
                        bitmap.shadow = new createjs.Shadow("#000000", 5, 5, 10);
                        _this.container.parent.updateCache();
                    });

                    this.container.on("pressup", function () {
                        bitmap.shadow = null;
                        _this.container.parent.updateCache();
                    });

                    return this.container;
                }

                _createClass(Hotspot, [{
                    key: "createBitmap",
                    value: function createBitmap(picture) {
                        var bitmap = new createjs.Bitmap(picture);
                        this.container.addChild(bitmap);
                        return bitmap;
                    }
                }, {
                    key: "createShape",
                    value: function createShape(bitmap) {
                        var shape = new createjs.Shape();
                        var bitmapBounds = bitmap.getBounds();

                        shape.graphics.setStrokeStyle(10).beginStroke("red").drawRect(0, 0, bitmapBounds.height, bitmapBounds.width);

                        shape.visible = false;

                        this.container.addChild(shape);

                        return shape;
                    }
                }], [{
                    key: "setRandomPosition",
                    value: function setRandomPosition(container) {
                        var containerBounds = container.getBounds();
                        var parentContainerBounds = container.parent.getBounds();
                        container.x = Math.floor(Math.random() * (parentContainerBounds.width - containerBounds.width)) + 1;
                        container.y = Math.floor(Math.random() * (parentContainerBounds.height - containerBounds.height)) + 1;
                    }
                }]);

                return Hotspot;
            })();

            _export("Hotspot", Hotspot);
        }
    };
});
System.register("src/Pages.js", ["npm:babel-runtime@5.6.17/helpers/create-class.js", "npm:babel-runtime@5.6.17/helpers/class-call-check.js", "src/Hotspot.js"], function (_export) {
    var _createClass, _classCallCheck, Hotspot, Pages;

    return {
        setters: [function (_npmBabelRuntime5617HelpersCreateClassJs) {
            _createClass = _npmBabelRuntime5617HelpersCreateClassJs["default"];
        }, function (_npmBabelRuntime5617HelpersClassCallCheckJs) {
            _classCallCheck = _npmBabelRuntime5617HelpersClassCallCheckJs["default"];
        }, function (_srcHotspotJs) {
            Hotspot = _srcHotspotJs.Hotspot;
        }],
        execute: function () {
            "use strict";

            Pages = (function () {
                function Pages() {
                    _classCallCheck(this, Pages);
                }

                _createClass(Pages, null, [{
                    key: "createPages",
                    value: function createPages(pictures, callback) {
                        var pages = [];
                        for (var index = 0; index < pictures.length; index++) {
                            pages.push(Pages.createPage(pictures[index], index, callback));
                        }
                        return pages;
                    }
                }, {
                    key: "createPage",
                    value: function createPage(src, index, callback) {
                        var pageContainer = Pages.createPageContainer(src, index);
                        pageContainer.addChild(new createjs.Bitmap(src));

                        for (var xyz = 0; xyz <= 50; xyz++) {
                            Pages.createHotSpot(pageContainer, callback);
                        }

                        return pageContainer;
                    }
                }, {
                    key: "createHotSpot",
                    value: function createHotSpot(container, callback) {
                        var picture = new Image();
                        var index = Math.floor(Math.random() * 3) + 1;
                        picture.src = "img/hotspot_" + index + ".jpeg";
                        picture.onload = function () {
                            var hotspot = new Hotspot(picture);
                            container.addChild(hotspot);
                            Hotspot.setRandomPosition(hotspot);
                            callback();
                        };
                    }
                }, {
                    key: "createPageContainer",
                    value: function createPageContainer(picture, index) {
                        var pageContainer = new createjs.Container();
                        var innerWidth = window.innerWidth * 2 / 2; // double page
                        var ratio = Math.min(innerWidth / picture.width, window.innerHeight * 2 / picture.height);
                        var rectWidth = ratio * picture.width;

                        pageContainer.scaleX = pageContainer.scaleY = window.innerHeight * 2 / picture.height;
                        pageContainer.x = (rectWidth + 10) * index;
                        pageContainer.y = 0;

                        return pageContainer;
                    }
                }]);

                return Pages;
            })();

            _export("Pages", Pages);
        }
    };
});
System.register('src/Main.js', ['npm:babel-runtime@5.6.17/helpers/create-class.js', 'npm:babel-runtime@5.6.17/helpers/class-call-check.js', 'github:CreateJS/EaselJS@0.8.1.js', 'github:CreateJS/TweenJS@0.6.1.js', 'src/Pages.js', 'github:hammerjs/hammer.js@2.0.4.js'], function (_export) {
    var _createClass, _classCallCheck, EaselJS, TweenJS, Pages, Hammer, Main;

    function initCanvas() {
        var canvasElement = document.getElementById('demoCanvas');
        //canvasElement.width = window.innerWidth * window.devicePixelRatio;
        canvasElement.width = window.innerWidth * 2;
        //canvasElement.height = window.innerHeight * window.devicePixelRatio;
        canvasElement.height = window.innerHeight * 2;
        canvasElement.style.width = window.innerWidth;
        canvasElement.style.height = window.innerHeight;
        return canvasElement;
    }

    return {
        setters: [function (_npmBabelRuntime5617HelpersCreateClassJs) {
            _createClass = _npmBabelRuntime5617HelpersCreateClassJs['default'];
        }, function (_npmBabelRuntime5617HelpersClassCallCheckJs) {
            _classCallCheck = _npmBabelRuntime5617HelpersClassCallCheckJs['default'];
        }, function (_githubCreateJSEaselJS081Js) {
            EaselJS = _githubCreateJSEaselJS081Js.EaselJS;
        }, function (_githubCreateJSTweenJS061Js) {
            TweenJS = _githubCreateJSTweenJS061Js.TweenJS;
        }, function (_srcPagesJs) {
            Pages = _srcPagesJs.Pages;
        }, function (_githubHammerjsHammerJs204Js) {
            Hammer = _githubHammerjsHammerJs204Js;
        }],
        execute: function () {
            'use strict';

            _export('initCanvas', initCanvas);

            Main = (function () {
                function Main(canvas) {
                    _classCallCheck(this, Main);

                    this.pages = new Array(6);
                    this.pagesCount = 0;

                    this.canvas = canvas;
                    this.canvas.onmousemove = this.onMouseMove.bind(this);

                    this.stage = new createjs.Stage(this.canvas);
                    window.stage = this.stage;

                    this.globalContainer = new createjs.Container();
                    this.globalContainer.x = 0;
                    this.globalContainer.y = 0;
                    this.globalContainer.orgX = this.globalContainer.x;

                    createjs.Touch.enable(this.stage);
                    createjs.Ticker.timingMode = createjs.Ticker.RAF;
                    createjs.Ticker.setFPS(30);
                    createjs.Ticker.addEventListener('tick', this.stage);

                    this.initHammer();
                    this.loadPages();
                }

                _createClass(Main, [{
                    key: 'initHammer',
                    value: function initHammer() {
                        var mc = new Hammer.Manager(this.canvas, {
                            recognizers: [[Hammer.Swipe], [Hammer.Tap], [Hammer.Pan], [Hammer.Pinch]]
                        });

                        mc.on('swipe', this.onSwipe.bind(this));
                        mc.on('pan', this.onPan.bind(this));
                        mc.on('panend', this.onPanEnd.bind(this));
                        mc.on('tap', this.onTap.bind(this));
                    }
                }, {
                    key: 'loadPages',
                    value: function loadPages() {
                        for (var i = 0; i < this.pages.length; i++) {
                            this.pages[i] = new Image();
                            this.pages[i].src = 'img/page_' + (i + 1) + '.png';
                            this.pages[i].onload = this.onImageLoad.bind(this);
                        }
                    }
                }, {
                    key: 'onImageLoad',
                    value: function onImageLoad() {
                        var _this = this;

                        this.pagesCount++;
                        if (this.pagesCount >= this.pages.length) {
                            (function () {
                                var elementsLoaded = 0;
                                var pages = Pages.createPages(_this.pages, function () {
                                    elementsLoaded++;
                                    if (elementsLoaded === 306) {
                                        for (var i = 0; i < pages.length; i++) {
                                            pages[i].cache(0, 0, 1862, 1862);
                                            _this.globalContainer.addChild(pages[i]);
                                        }
                                        stage.addChild(_this.globalContainer);
                                        stage.update();
                                    }
                                });
                            })();
                        }
                    }
                }, {
                    key: 'onPanEnd',
                    value: function onPanEnd(ev) {
                        this.globalContainer.orgX = this.globalContainer.x;
                    }
                }, {
                    key: 'onPan',
                    value: function onPan(ev) {
                        var x = this.globalContainer.orgX + ev.deltaX;
                        createjs.Tween.get(this.globalContainer).to({ x: x });
                    }
                }, {
                    key: 'onSwipe',
                    value: function onSwipe(ev) {}
                }, {
                    key: 'onTap',
                    value: function onTap(ev) {}
                }, {
                    key: 'onClick',
                    value: function onClick(ev) {}
                }, {
                    key: 'onMouseMove',
                    value: function onMouseMove(e) {
                        if (!e) {
                            e = window.event;
                        }
                        this.stage.mouseX = e.pageX - this.canvas.offsetLeft;
                        this.stage.mouseY = e.pageY - this.canvas.offsetTop;
                    }
                }]);

                return Main;
            })();

            _export('Main', Main);
        }
    };
});
System.register('src/App.js', ['src/Main.js'], function (_export) {
    'use strict';

    var Main, initCanvas;
    return {
        setters: [function (_srcMainJs) {
            Main = _srcMainJs.Main;
            initCanvas = _srcMainJs.initCanvas;
        }],
        execute: function () {
            window.onload = function () {
                new Main(initCanvas());
            };
        }
    };
});
})
(function(factory) {
  factory();
});
//# sourceMappingURL=app.js.map