'use strict';

const get = require('lodash.get');
const set = require('lodash.set');
const values = require('lodash.values');
const map = require('lodash.map');
const reduce = require('lodash.reduce');
const express = require('express');
const path = require('path');
const assert = require('assert');
const semver = require('semver');
const auth = require('basic-auth');
const compare = require('tsscmp');

const SWAGGER_VERSION = '2.0';
const SWAGGER_BASE_PATH = '__swagger__';
const MINIMAL_VERSION_REQUIRED = '0.8.17';

const DEFAULT_RESPONSES = {
  default: { description: 'Default responses' }
};

// Install swagger plugin
function buildSwaggerConfig(app, options) {
  options = options || {};
  let defaultResponses = options.defaultResponses || DEFAULT_RESPONSES;
  let tags = [];
  let paths = {};
  let definitions = Object.assign({}, get(options, 'swagger.definitions') || {});

  let addedTags = {};

  let supportTypes = app.get('adapterOptions.supportedTypes') || [
    'application/json'
  ];

  let acceptTypes = [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data'
  ];

  // Default swagger config
  let swagger = Object.assign({
    basePath: '/',
    schemes: ['http'],
    host: '',
    swagger: SWAGGER_VERSION,
    info: {
      title: app.get('title') || '',
      description: app.get('description') || '',
      version: app.get('version')
    }
  }, options.swagger || {});

  // Build security
  let securities = map(swagger.securityDefinitions || {}, function(security, name) {
    let res = {};
    if (security.type === 'oauth2') {
      res[name] = Object.keys(security.scopes || {});
    } else {
      res[name] = [];
    }
    return res;
  });

  // Transfer `:id` like parameter to `{id}`
  function pathReplacer(path) {
    return path.replace(/:([a-zA-Z0-9\-_]+)/g, function(__, capture) {
      return `{${capture}}`;
    });
  }

  // extract required names for definitions according to params
  function extractRequiredNames(params) {
    let requireds = [];
    map(params, function(param) {
      param.required && requireds.push(param.name);
    });
    return requireds;
  }

  // Detect whether parameters should be placed in body, formData or query
  // Header currently is not supported
  function chooseParameterPositionBy(verb, params) {
    if (['get', 'options'].indexOf(verb) > -1) return 'query';

    let shouldInBody;

    if (params.length) {
      shouldInBody = reduce(params, function(res, param) {
        if (param.params) {
          return res || true;
        } else {
          return res || false;
        }
      }, false);
    } else {
      // Set parameter position as `body` when there is on params required
      shouldInBody = true;
    }

    return shouldInBody ? 'body' : 'formData';
  }

  // Build swagger compatible parameters
  function buildParameters(method, params, definitionPrefix, buildForDefinitiion) {
    let defaultIn = buildForDefinitiion ?
      'query' :
      chooseParameterPositionBy(method.route.verb, params);

    let path = method.fullPath();

    let bodyDefinitionKey = `${method.fullName()}.params`;
    definitionPrefix = definitionPrefix || `${bodyDefinitionKey}.`;

    let result = {};
    let body = {};
    let isInBody = defaultIn === 'body';

    // Iterate over all parameters
    map(params, function(param) {
      let conf = {
        description: param.description,
        default: param.default,
        required: param.required || false,
      };

      // Prepare definitiion for complex structure
      let definitionKey;
      let ref;
      if (param.params) {
        definitionKey = definitionPrefix + param.name;
        ref = `#/definitions/${definitionKey}`;

        definitions[definitionKey] = {
          type: 'object',
          required: extractRequiredNames(param.params),
          properties: buildParameters(method, param.params, definitionKey + '.', true)
        };
      }

      // Analyze param type and related schema
      // Hanlde array type
      if (Array.isArray(param.type)) {
        conf.type = 'array';

        if (param.params) {
          conf.items = { $ref: ref };
        } else {
          conf.items = { type: param.type[0] };
        }

        // Add enum support
        if (param.enum && param.enum.length) conf.items.enum = param.enum;
      } else {
        // Handle Object type
        if (param.params) {
          conf.schema = { $ref: ref };
        }

        // Handle other types
        else {
          if (param.type === 'date') {
            conf.type = 'string';
            conf.format = 'date-time';
          } else {
            conf.type = param.type;
          }

          if (param.enum && param.enum.length) conf.enum = param.enum;
        }
      }

      // Build for definitions' properties
      if (buildForDefinitiion) {
        result[param.name] = conf;
      }

      // Build for parameters
      else {
        // check whether parameter in path
        let paramInPath = path.indexOf(`:${param.name}`) > -1;
        if (paramInPath) conf.in = 'path';

        // If param is not in path and in body, add it to body schema
        if (isInBody && !paramInPath) {
          if (conf.schema) {
            body[param.name] = conf.schema;
          } else {
            body[param.name] = conf;
          }
        }

        // If param is not in body, add it to parameters directly
        else {
          // add `name`, `in`, `required` property
          conf.in = conf.in || defaultIn;
          conf.name = param.name;

          // Param in path must be required
          conf.required = paramInPath ? true : param.required;

          result[param.name] = conf;
        }
      }
    });

    if (buildForDefinitiion) {
      return result;
    } else {
      result = values(result);
      if (isInBody) {
        if (Object.keys(body).length) {
          definitions[bodyDefinitionKey] = {
            type: 'object',
            properties: body
          };

          result.push({
            in: 'body',
            name: 'body',
            description: 'body',
            required: true,
            schema: {
              $ref: `#/definitions/${bodyDefinitionKey}`
            }
          });
        } else {
          // Allow pass json body to post action
          result.push({
            in: 'body',
            name: 'body',
            description: 'body',
            required: false,
            schema: {
              type: 'object'
            }
          });
        }
      }

      return result;
    }
  }

  // Add tag by name and description
  function addTag(name, description) {
    if (addedTags[name]) return;
    tags.push({
      name: name,
      description: description
    });

    addedTags[name] = true;
  }

  // Choose content type
  function chooseContentType(params) {
    let consumes = ['application/json'];
    for (let i = 0; i < params.length; i++) {
      let param = params[i] || {};
      if (param.type === 'file') {
        consumes = ['multipart/form-data'];
        break;
      }

      if (param.in === 'formData') {
        consumes = ['application/x-www-form-urlencoded'];
        break;
      }
    }

    return consumes;
  }

  // add path by method
  function addPath(method) {
    if (method.name === '__swagger__') return;

    let path = pathReplacer(method.fullPath());
    let httpMethod = method.route.verb;

    if (httpMethod === 'use') return;

    let pathConfig = get(paths, path) || {};

    let tagName = get(method, 'parent.name') || '';
    let tagDesc = get(method, 'parent.description') || get(method, 'parent.settings.description') || '';

    addTag(tagName, tagDesc);

    let parameters = buildParameters(method, method.params);

    // Choose content-type
    let consumes = chooseContentType(parameters);

    if (httpMethod === 'all') {
      ['get', 'post', 'put', 'delete', 'patch'].forEach(function(verb) {
        pathConfig[verb] = {
          tags: [tagName],
          summary: `${method.fullName()} => ${method.description}`,
          description: method.notes,
          consumes: consumes,
          produces: supportTypes,
          parameters: parameters,
          responses: defaultResponses || {},
          security: securities
        };
      });
    } else {
      pathConfig[httpMethod] = {
        tags: [tagName],
        summary: `${method.fullName()} => ${method.description}`,
        description: method.notes,
        consumes: consumes,
        produces: supportTypes,
        parameters: parameters,
        responses: defaultResponses || {},
        security: securities
      };
    }

    set(paths, path, pathConfig);
  }

  app.allMethods().map(addPath);

  swagger.tags = tags;
  swagger.paths = paths;
  swagger.definitions = definitions;
  swagger.consumes = acceptTypes;
  swagger.produces = supportTypes;

  return swagger;
}

// Swagger Plugin
function swaggerPlugin(app, options) {
  // Check baiji version
  assert(
    semver.satisfies(app.constructor.VERSION, `>= ${MINIMAL_VERSION_REQUIRED}`),
    `baiji-swagger plugin require baiji version larger than ${MINIMAL_VERSION_REQUIRED}`
  );

  app.on('mount', function() {
    let config = buildSwaggerConfig(this, options);

    function createSwaggerServer(configUrl) {
      let swaggerApp = express();

      let basicAuth = get(options, 'basicAuth') || {};
      let authEnabled = basicAuth.name && basicAuth.pass;

      // Set view config
      swaggerApp.set('view engine', 'ejs');
      swaggerApp.set('views', path.join(__dirname, 'views'));

      // Static files support
      swaggerApp.use(
        express.static(
          path.dirname(require.resolve('swagger-ui-dist/index.html')),
          { index: false }
        )
      );

      // Basic function to validate credentials for example
      function check(credentials) {
        let valid = true;

        // Simple method to prevent short-circut and use timing-safe compare
        valid = compare(credentials.name, basicAuth.name) && valid;
        valid = compare(credentials.pass, basicAuth.pass) && valid;

        return valid;
      }

      // Check Auth passed or not
      function authorize(req, res, next) {
        const credentials = auth(req);
        const authPassed = credentials && check(credentials);
        if (authEnabled && !authPassed) {
          res.status(401);
          res.set('WWW-Authenticate', 'Basic realm="example"');
          res.send('Access denied');
        } else {
          next();
        }
      }

      // Swagger ui
      swaggerApp.get('/', authorize, function(req, res) {
        res.render(
          'index', {
            title: get(config, 'info.title'),
            configUrl
          }
        );
      });

      // Swagger config api
      swaggerApp.get('/config', authorize, function (req, res) {
        res.send(config);
      });

      return swaggerApp;
    }

    // use swagger service middleware
    this.use(
      createSwaggerServer(
        path.posix.join(
          config.basePath || '/',
          this.fullPath(),
          SWAGGER_BASE_PATH,
          'config'
        )
      ),
      {
        name: SWAGGER_BASE_PATH,
        description: 'swagger documentation plugin',
        mountPath: SWAGGER_BASE_PATH
      }
    );
  });

  return null;
}

module.exports = swaggerPlugin;
