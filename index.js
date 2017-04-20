'use strict';

const get = require('lodash.get');
const set = require('lodash.set');
const values = require('lodash.values');
const map = require('lodash.map');
const reduce = require('lodash.reduce');
const express = require('express');
const path = require('path');

const SWAGGER_VERSION = '2.0';
const SWAGGER_BASE_PATH = '__swagger__';

const DEFAULT_RESPONSES = {
  default: { description: 'Default responses' }
};

function createSwaggerServer(config, url) {
  let app = express();

  // Set view config
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // set
  app.use(express.static(path.join(__dirname, 'dist')));

  app.get('/config', function(req, res) {
    res.send(config);
  });

  app.get('/', function(req, res) {
    res.render('index', { title: get(config, 'info.title'), configUrl: url });
  });

  return app;
}

function swaggerPlugin(app, options) {
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

  // Transfer `:id` like parameter to `{id}`
  function pathReplacer(path) {
    return path.replace(/:([a-zA-Z0-9\-\_]+)/g, function(__, capture) {
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

    let shouldInBody = reduce(params, function(res, param) {
      if (param.params) {
        return res || true;
      } else {
        return res || false;
      }
    }, false);

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
        default: param.default
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
      if (isInBody && Object.keys(body).length) {

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

    pathConfig[httpMethod] = {
      tags: [tagName],
      summary: method.description,
      description: method.notes,
      consumes: acceptTypes,
      produces: supportTypes,
      parameters: buildParameters(method, method.params),
      responses: defaultResponses || {}
    };

    set(paths, path, pathConfig);
  }

  app.allMethods().map(addPath);

  swagger.tags = tags;
  swagger.paths = paths;
  swagger.definitions = definitions;

  // use swagger service middleware
  app.use(
    createSwaggerServer(
      swagger,
      path.posix.join(app.fullPath(), SWAGGER_BASE_PATH, 'config')
    ),
    {
      name: SWAGGER_BASE_PATH,
      description: 'swagger documentation plugin',
      mountPath: SWAGGER_BASE_PATH
    }
  );
}

module.exports = swaggerPlugin;
