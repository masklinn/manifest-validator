/*jshint node:true, strict:false */

var request = require('request'),
    http    = require('http'),
    url     = require('url');


// -- Helper functions --------------------------------------------------------
function stringToArray(fileContents) {
  if ( typeof fileContents !== 'string' ) { return []; }

  // In case of a Windows file, remove CRs first
  fileContents = fileContents.replace(/\r/g, '');
  return fileContents.split('\n');
}


function isValidUrl(url) {
  // Slightly modified version of Diego Perini's Regular Expression for URL validation
  // https://gist.github.com/729294
  var validUrl = new RegExp(
    "^" +
      // protocol identifier
      "https?://" +
      "(?:" +
        // IP address exclusion
        // private & local networks
        "(?!10(?:\\.\\d{1,3}){3})" +
        //"(?!127(?:\\.\\d{1,3}){3})" +
        "(?!169\\.254(?:\\.\\d{1,3}){2})" +
        "(?!192\\.168(?:\\.\\d{1,3}){2})" +
        "(?!172\\.(?:1[6-9]|2\\d|3[0-1])(?:\\.\\d{1,3}){2})" +
        // IP address dotted notation octets
        // excludes loopback network 0.0.0.0
        // excludes reserved space >= 224.0.0.0
        // excludes network & broacast addresses
        // (first & last IP address of each class)
        "(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])" +
        "(?:\\.(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}" +
        "(?:\\.(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]))" +
      "|" +
        // host name
        "(?:(?:[a-z\\u00a1-\\uffff0-9]+-?)*[a-z\\u00a1-\\uffff0-9]+)" +
        // domain name
        "(?:\\.(?:[a-z\\u00a1-\\uffff0-9]+-?)*[a-z\\u00a1-\\uffff0-9]+)*" +
        // TLD identifier
        "(?:\\.(?:[a-z\\u00a1-\\uffff]{2,}))" +
      ")" +
      // port number
      "(?::\\d{2,5})?" +
      // resource path
      "(?:/[^\\s]*)?" +
    "$", "i"
  );
  return validUrl.test(url);
}


function trim(string) {
  return string.replace(/^[ \t]+|[ \t]+$/, '');
}


// -- Manifest -------------------------------------------------------
var Manifest = function(content) {
  this.content          = content || null;
  this.baseUrl          = 'http://127.0.0.1/';
  this.errors           = [];
  this.resources        = [];
  this.invalidResources = [];
};


Manifest.prototype.loadFromUri = function(manifestUri, callback) {
  var self = this;

  if (!isValidUrl(manifestUri)) {
    callback('ERR_INVALID_URI');
    return;
  }

  request({uri: manifestUri}, function (err, res, body) {
    if (err || !res || res.statusCode !== 200) {
      callback('ERR_LOAD_URI');
      return;
    }

    // Strict MIME type checking has been removed from current appcache spec:
    // http://html5.org/tools/web-apps-tracker?from=6822&to=6823
    //
    // Just make sure, we have a text file
    if ( ['text/plain', 'text/cache-manifest'].indexOf( res.headers['content-type'].split(';')[0] ) === -1 ) {
      callback('ERR_MANIFEST_MIMETYPE');
      return;
    }

    var href = res.request.uri.href;
    self.baseUrl = href.substring(0, href.lastIndexOf('/') + 1);
    self.content = body;
    callback(err, body);
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
    if ( err || !res || !res.request ) {
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
      parsingMode = 'explicit',
      absoluteUrl;

  // Check empty file
  if (manifest.length === 0) {
    this.errors[0] = { error: 'ERR_EMPTY_FILE' };
    this.resources = [];
    return false;
  }

  // Check manifest signature
  if (manifest[0] !== "CACHE MANIFEST") {
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
    switch (currentLine) {
      case 'CACHE:':    parsingMode = 'explicit';  continue;
      case 'FALLBACK:': parsingMode = 'fallback';  continue;
      case 'NETWORK:':  parsingMode = 'whitelist'; continue;
    }

    var isValidResource = true;

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
        var baseUrl     = url.parse(this.baseUrl);
        firstUrl        = url.parse(firstUrl);
        absoluteUrl     = url.parse(absoluteUrl);

        if (
          baseUrl.protocol !== firstUrl.protocol || baseUrl.hostname !== firstUrl.hostname || baseUrl.port !== firstUrl.port ||
          baseUrl.protocol !== absoluteUrl.protocol || baseUrl.hostname !== absoluteUrl.hostname || baseUrl.port !== absoluteUrl.port
        ) {
          this.errors[i] = {
            error:   'ERR_FALLBACK_SAME_ORIGIN',
            content: currentLine
          };
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
              error:   'ERR_WHITELIST_SAME_SHEME',
              content: currentLine
            };
          }
        }
        break;
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