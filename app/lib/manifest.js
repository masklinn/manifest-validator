'use strict';

var isValidUrl = require('./validate-url'),
    config     = require('./config.js'),
    request    = require('request'),
    url        = require('url'),
    zlib       = require('zlib');


// -- Helper functions --------------------------------------------------------
function stringToArray(fileContents) {
  if ( typeof fileContents !== 'string' ) { return []; }

  // In case of a Windows file, remove CRs first
  fileContents = fileContents.replace(/\r/g, '');
  return fileContents.split('\n');
}


function trim(string) {
  return string.replace(/^[ \t]+|[ \t]+$/, '');
}


// -- Manifest -------------------------------------------------------
var Manifest = function(content) {
  this.content          = content || null;
  this.baseUrl          = 'http://127.0.0.1/';
  this.errors           = [];
  this.warnings         = [];
  this.resources        = [];
  this.invalidResources = [];
};


Manifest.prototype.loadFromUri = function(manifestUri, callback) {
  var self = this;

  if (!isValidUrl(manifestUri)) {
    callback('ERR_INVALID_URI');
    return;
  }

  request({
    uri      : manifestUri,
    // Return response as buffer, so we can check for deflate/gzip response
    encoding : null,
    timeout  : config.uri.timeout
  },
  function (err, res, body) {
    if (err || !res || res.statusCode !== 200) {
      callback('ERR_LOAD_URI');
      return;
    }

    // Strict MIME type checking has been removed from current appcache spec:
    // http://html5.org/tools/web-apps-tracker?from=6822&to=6823
    //
    // Just make sure, we have a text file
    var contentType = '';

    try {
      contentType = res.headers['content-type'].split(';')[0];
      if ( ['text/plain', 'text/cache-manifest'].indexOf( contentType ) === -1 ) {
        callback('ERR_MANIFEST_MIMETYPE');
        return;
      }
    } catch(e) {
      // TODO: Debug statement in production, had some strange output in the error logs.
      // Should be removed again
      console.error('manifest.js: Content-Type');
      return;
    }

    // Issue a warning instead, as spec says it *should* be served with that type.
    if ( contentType.indexOf('text/cache-manifest') === -1 ) {
      self.warnings[0] = { error: 'WARN_MANIFEST_MIMETYPE' };
    }

    var href = res.request.uri.href;
    self.baseUrl = href.substring(0, href.lastIndexOf('/') + 1);

    var encoding       = res.headers['content-encoding'];
    var decodeResponse = function(err, decoded) {
      self.content = decoded.toString();
      callback(err, decoded && decoded.toString());
      return;
    };

    if (zlib && encoding) {
      if (encoding === 'gzip') {
        return zlib.gunzip(body, decodeResponse);
      }
      if (encoding === 'deflate') {
        return zlib.inflate(body, decodeResponse);
      } else {
        return decodeResponse(null, body);
      }
    } else {
      return decodeResponse(null, body);
    }
  });
};


Manifest.prototype.checkResources = function(callback) {
  if (this.resources.length === 0) {
    callback();
    return;
  }

  var requestsLeft = 0,
    self = this;

  function processRequest(err, res, lineNumber) {
    // Ignore 'Transport endpoint is not connected' errors, see
    // https://groups.google.com/d/topic/nodejs/XL6Jm40uLUc/discussion
    if ( err ) {
      if (err.code !== 'ENOTCONN' && err.syscall !== 'shutdown') {
        self.errors[lineNumber] = { error: 'ERR_RESOURCE_ERROR' };
      }
    } else if ( !res || !res.request ) {
      self.errors[lineNumber] = { error: 'ERR_RESOURCE_ERROR' };
    } else if ( [200, 301, 302, 307].indexOf(res.statusCode) === -1 ) {
      self.invalidResources[lineNumber] = url.resolve((res.request.port === 80 ? 'http://' : 'https://') + res.request.host, res.request.path);
    }

    // Proceed if semaphore is finished
    if (--requestsLeft === 0) {
      callback();
    }
  }

  function headRequest(lineNumber, resource){
    request.head({uri: resource}, function(err, res) { processRequest(err, res, lineNumber); });
  }

  for (var i in this.resources) {
    if (this.resources.hasOwnProperty(i) && this.resources[i]) {
      requestsLeft++;

      var resource = url.resolve(this.baseUrl, this.resources[i]);
      headRequest(i, resource);
    }
  }
};


Manifest.prototype.validate = function() {
  var manifest = stringToArray(this.content),
      parsingModes = {
        'CACHE:'    : 'explicit',
        'FALLBACK:' : 'fallback',
        'NETWORK:'  : 'whitelist',
        // http://www.whatwg.org/specs/web-apps/current-work/multipage/offline.html#concept-appcache-manifest-settings
        'SETTINGS:' : 'settings'
      },
      parsingMode = 'explicit',
      isValidResource,
      baseUrl, firstUrl, absoluteUrl,
      whitelisted = {},
      fallbacks = {};

  // Check empty file
  if (manifest.length === 0) {
    this.errors[0] = { error: 'ERR_EMPTY_FILE' };
    this.resources = [];
    return false;
  }

  // Check manifest signature
  if ( /^\uFEFF?CACHE\u0020MANIFEST/.test(manifest[0]) === false) {
    this.errors[0] = {
      error:   'ERR_MANIFEST_HEADER',
      content: manifest[0]
    };
    this.resources = [];
    return false;
  }

  for (var i=1,lines=manifest.length; i<lines; i++) {
    var currentLine = manifest[i];

    // Trim whitespaces
    currentLine = trim(currentLine);


    // Ignore empty lines and comments
    if ( /^(#.*)?$/.test(currentLine) ) { continue; }


    // Comments after url tokens are invalid
    if ( /\s+#.*?$/.test(currentLine) ) {
      this.errors[i] = {
        error:   'ERR_MANIFEST_INVALID_RESOURCE',
        content: currentLine
      };
      continue;
    }


    // Check for parsing mode changes
    if (parsingModes[currentLine]) {
      parsingMode = parsingModes[currentLine];
      continue;
    }

    isValidResource = true;

    // Now we're talking URL business
    switch (parsingMode) {
      case 'explicit':
        absoluteUrl     = url.resolve(this.baseUrl, currentLine);
        isValidResource = isValidUrl(absoluteUrl);
        break;

      case 'fallback':
        var token = currentLine.split(/[ \t]+/);
        if (token.length !== 2) {
          isValidResource = false;
          break;
        }

        firstUrl        = url.resolve(this.baseUrl, trim(token[0]));
        absoluteUrl     = url.resolve(this.baseUrl, trim(token[1]));
        isValidResource = isValidUrl(firstUrl) && isValidUrl(absoluteUrl);

        // Check for same origin policy
        baseUrl         = url.parse(this.baseUrl);
        firstUrl        = url.parse(firstUrl);
        absoluteUrl     = url.parse(absoluteUrl);

        if (
          baseUrl.protocol !== firstUrl.protocol || baseUrl.hostname !== firstUrl.hostname || baseUrl.port !== firstUrl.port ||
          baseUrl.protocol !== absoluteUrl.protocol || baseUrl.hostname !== absoluteUrl.hostname || baseUrl.port !== absoluteUrl.port
        ) {
          // Only issue a warning on upload/direct input
          if (this.baseUrl !== 'http://127.0.0.1/') {
            this.errors[i] = {
              error:   'ERR_FALLBACK_SAME_ORIGIN',
              content: currentLine
            };
          } else {
            this.warnings[i] = {
              error:   'ERR_FALLBACK_SAME_ORIGIN',
              content: currentLine
            };
          }
        } else {
            fallbacks[firstUrl] = i;
        }
        break;

      case 'whitelist':
        if ( currentLine.indexOf('*') !== 0 ) {
          absoluteUrl     = url.resolve(this.baseUrl, currentLine);
          isValidResource = isValidUrl(absoluteUrl);

          // Compare shemes (=protocols) of manifest URL and whitelist entry
          baseUrl         = url.parse(this.baseUrl);
          absoluteUrl     = url.parse(absoluteUrl);

          if (baseUrl.protocol !== absoluteUrl.protocol) {
            this.errors[i] = {
              error:   'ERR_WHITELIST_SAME_SCHEME',
              content: currentLine
            };
          } else {
              whitelisted[absoluteUrl] = i;
          }
        }
        break;

      case 'settings':
        isValidResource = true;
        if ( currentLine.indexOf('prefer-online') !== 0 ) {
          this.errors[i] = {
            error:   'ERR_INVALID_SETTING',
            content: currentLine
          };
        } else {
          this.warnings[i] = {
            error:   'WARN_SETTINGS_ONLY_WHATWG',
            content: currentLine
          };
        }
        break;
    }

    for (var w in whitelisted) {
      for (var f in fallbacks) {
        if (w === f || f.indexOf(w) === 0) {
          this.warnings[fallbacks[f]] = {
            error:   'ERR_FALLBACK_IGNORED',
            content: "lines " + whitelisted[w] + " and " + fallbacks[f],
          }
        }
      }
    }

    // Push the results to the corresponding arrays
    if ( isValidResource ) {
      this.resources[i] = absoluteUrl;
    } else {
      this.errors[i] = {
        error:   'ERR_MANIFEST_INVALID_RESOURCE',
        content: currentLine
      };
    }
  }
  return (this.errors.length === 0);
};


module.exports = Manifest;
