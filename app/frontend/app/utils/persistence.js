import Ember from 'ember';
import CoughDrop from '../app';
import coughDropExtras from './extras';
import stashes from './_stashes';
import speecher from './speecher';
import i18n from './i18n';
import contentGrabbers from './content_grabbers';
import Utils from './misc';
import modal from './modal';
import capabilities from './capabilities';

var valid_stores = ['user', 'board', 'image', 'sound', 'settings', 'dataCache', 'buttonset'];
var persistence = Ember.Object.extend({
  setup: function(container, application) {
    application.register('cough_drop:persistence', persistence, { instantiate: false, singleton: true });
    Ember.$.each(['model', 'controller', 'view', 'route'], function(i, component) {
      application.inject(component, 'persistence', 'cough_drop:persistence');
    });
    persistence.find('settings', 'lastSync').then(function(res) {
      persistence.set('last_sync_at', res.last_sync);
    }, function() { });
    coughDropExtras.addObserver('ready', function() {
      persistence.find('settings', 'lastSync').then(function(res) {
        persistence.set('last_sync_at', res.last_sync);
      }, function() {
        persistence.set('last_sync_at', 0);
      });
    });
    if(stashes.get_object('just_logged_in', false) && stashes.get('auth_settings') && !Ember.testing) {
      stashes.persist_object('just_logged_in', null, false);
      Ember.run.later(function() {
        if(!persistence.get('syncing')) {
          persistence.sync('self').then(null, function() { });
        }
      }, 10000);
    }
    coughDropExtras.advance.watch('device', function() {
      if(!CoughDrop.ignore_filesystem) {
        capabilities.storage.status().then(function(res) {
          if(res.available && !res.requires_confirmation) {
            res.allowed = true;
          }
          persistence.set('local_system', res);
        });
        Ember.run.later(function() {
          persistence.prime_caches().then(null, function() { });
        }, 100);
        Ember.run.later(function() {
          if(persistence.get('local_system.allowed')) {
            persistence.prime_caches(true).then(null, function() { });
          }
        }, 2000);
      }
    });
  },
  test: function(method, args) {
    method.apply(this, args).then(function(res) {
      console.log(res);
    }, function() {
      console.error(arguments);
    });
  },
  push_records: function(store, keys) {
    var hash = {};
    var res = {};
    keys.forEach(function(key) { hash[key] = true; });
    CoughDrop.store.peekAll(store).content.forEach(function(item) {
      var record = item.record;
      if(record && hash[record.get('id')]) {
        if(store == 'board' && record.get('permissions') === undefined) {
          // locally-cached board found from a list request doesn't count
        } else {
          hash[record.get('id')] = false;
          res[record.get('id')] = record;
        }
      }
    });
    var any_missing = false;
    keys.forEach(function(key) { if(hash[key] === true) { any_missing = true; } });
    if(any_missing) {
      return new Ember.RSVP.Promise(function(resolve, reject) {
        return coughDropExtras.storage.find_all(store, keys).then(function(list) {
          list.forEach(function(item) {
            if(item.data && item.data.id && hash[item.data.id]) {
              hash[item.data.id] = false;
              if(CoughDrop.store) {
                res[item.data.id] = CoughDrop.store.push(store, item.data.raw);
              }
            }
          });
          for(var idx in hash) {
            if(hash[idx] === true) {
              persistence.known_missing = persistence.known_missing || {};
              persistence.known_missing[store] = persistence.known_missing[store] || {};
              persistence.known_missing[store][idx] = true;
            }
          }
          resolve(res);
        }, function(err) {
          reject(err);
        });
      });
    } else {
      return Ember.RSVP.resolve(res);
    }
  },
  get_important_ids: function() {
    if(persistence.important_ids) {
      return Ember.RSVP.resolve(persistence.important_ids);
    } else {
      return coughDropExtras.storage.find('settings', 'importantIds').then(function(res) {
        persistence.important_ids = res.raw.ids || [];
        return persistence.important_ids;
      });
    }
  },
  find: function(store, key, wrapped, already_waited) {
    if(!window.coughDropExtras || !window.coughDropExtras.ready) {
      if(already_waited) {
        return Ember.RSVP.reject({error: "extras not ready"});
      } else {
        return new Ember.RSVP.Promise(function(resolve, reject) {
          coughDropExtras.advance.watch('all', function() {
            resolve(persistence.find(store, key, wrapped, true));
          });
        });
      }
    }
    if(!key) { /*debugger;*/ }
    return new Ember.RSVP.Promise(function(resolve, reject) {
      if(valid_stores.indexOf(store) == -1) {
        reject({error: "invalid type: " + store});
        return;
      }
      if(persistence.known_missing && persistence.known_missing[store] && persistence.known_missing[store][key]) {
        console.error('found a known missing!');
        reject({error: 'record not found'});
      }
      var id = Ember.RSVP.resolve(key);
      if(store == 'user' && key == 'self') {
        id = coughDropExtras.storage.find('settings', 'selfUserId').then(function(res) {
          return res.raw.id;
        });
      }
      var lookup = id.then(function(id) {
        return coughDropExtras.storage.find(store, id).then(function(record) {
          return persistence.get_important_ids().then(function(ids) {
            return Ember.RSVP.resolve({record: record, importantIds: ids});
          }, function(err) {
            // if we've never synced then this will be empty, and that's ok
            if(err && err.error && err.error.match(/no record found/)) {
              return Ember.RSVP.resolve({record: record, importantIds: []});
            } else {
              return Ember.RSVP.reject({error: "failed to find settings result when querying " + store + ":" + key});
            }
          });
        }, function(err) {
          return Ember.RSVP.reject(err);
        });
      });
      lookup.then(function(res) {
        var record = res.record;
        var importantIds = res.importantIds;
        var ago = (new Date()).getTime() - (7 * 24 * 60 * 60 * 1000); // >1 week old is out of date
        // TODO: garbage collection for db??? maybe as part of sync..
        if(record && record.raw) {
          record.raw.important = !!importantIds.find(function(i) { return i == (store + "_" + key); });
        }
        // if we have the opportunity to get it from an online source and it's out of date,
        // we should use the online source
        if(record && record.raw && !record.important && record.persisted < ago) {
          record.raw.outdated = true;
        }

        if(record) {
          var result = {};
          if(wrapped) {
            result[store] = record.raw;
          } else {
            result = record.raw;
          }
          resolve(result);
        } else {
          persistence.known_missing = persistence.known_missing || {};
          persistence.known_missing[store] = persistence.known_missing[store] || {};
          persistence.known_missing[store][key] = true;
          reject({error: "record not found"});
        }
      }, function(err) {
        persistence.known_missing = persistence.known_missing || {};
        persistence.known_missing[store] = persistence.known_missing[store] || {};
        persistence.known_missing[store][key] = true;
        reject(err);
      });
    });
  },
  remember_access: function(lookup, store, id) {
    if(lookup == 'find' && store == 'board') {
      var recent_boards = stashes.get('recent_boards') || [];
      recent_boards.unshift({id: id});
      var old_list = Utils.uniq(recent_boards.slice(0, 100), function(b) { return !b.id.toString().match(/^tmp_/) ? b.id : null; });
      var key = {};
      var list = [];
      old_list.forEach(function(b) {
        if(!key[b.id]) {
          list.push(b);
        }
      });
      stashes.persist('recent_boards', list);
    }
  },
  find_recent: function(store) {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      if(store == 'board') {
        var promises = [];
        var board_ids = [];
        stashes.get('recent_boards').forEach(function(board) {
          board_ids.push(board.id);
        });

        var find_local = coughDropExtras.storage.find_all(store, keys).then(function(list) {
          var res = [];
          list.forEach(function(item) {
            if(item.data && item.data.id && hash[item.data.id]) {
              if(CoughDrop.store) {
                var json_api = { data: {
                  id: item.data.raw.id,
                  type: 'board',
                  attributes: item.data.raw
                }};
                res.push(CoughDrop.store.push(json_api));
              }
            }
          });
          return Ember.RSVP.resolve(res);
        });
        find_local.then(function(list) {
          resolve(list);
        }, function(err) {
          reject({error: 'find_all failed for ' + store});
        });
      } else {
        reject({error: 'unsupported type: ' + store});
      }
    });
  },
  find_changed: function() {
    if(!window.coughDropExtras || !window.coughDropExtras.ready) {
      return Ember.RSVP.resolve([]);
    }
    return coughDropExtras.storage.find_changed();
  },
  find_boards: function(str) {
    var re = new RegExp("\\b" + str, 'i');
    var get_important_ids =  coughDropExtras.storage.find('settings', 'importantIds').then(function(res) {
      return Ember.RSVP.resolve(res.raw.ids);
    });

    var get_board_ids = get_important_ids.then(function(ids) {
      var board_ids = [];
      ids.forEach(function(id) {
        if(id.match(/^board_/)) {
          board_ids.push(id.replace(/^board_/, ''));
        }
      });
      return board_ids;
    });

    var get_boards = get_board_ids.then(function(ids) {
      var promises = [];
      var boards = [];
      var loaded_boards = CoughDrop.store.peekAll('board');
      ids.forEach(function(id) {
        var loaded_board = loaded_boards.findBy('id', id);
        if(loaded_board) {
          boards.push(loaded_board);
        } else {
          promises.push(persistence.find('board', id).then(function(res) {
            var json_api = { data: {
              id: res.id,
              type: 'board',
              attributes: res
            }};
            var obj = CoughDrop.store.push(json_api);
            boards.push(obj);
            return true;
          }));
        }
      });
      var res = Ember.RSVP.all(promises).then(function() {
        return boards;
      });
      promises.forEach(function(p) { p.then(null, function() { }); });
      return res;
    });

    var search_boards = get_boards.then(function(boards) {
      var matching_boards = [];
      boards.forEach(function(board) {
        var str = board.get('key') + " " + board.get('name') + " " + board.get('description');
        board.get('buttons').forEach(function(button) {
          str = str + " " + (button.label || button.vocalization);
        });
        if(str.match(re)) {
          matching_boards.push(board);
        }
      });
      return matching_boards;
    });

    return search_boards;
  },
  remove: function(store, obj, key, log_removal) {
    var _this = this;
    this.removals = this.removals || [];
    if(window.coughDropExtras && window.coughDropExtras.ready) {
      Ember.run.later(function() {
        var record = obj[store] || obj;
        record.id = record.id || key;
        var result = coughDropExtras.storage.remove(store, record.id).then(function() {
          return Ember.RSVP.resolve(obj);
        }, function(error) {
          return Ember.RSVP.reject(error);
        });

        if(log_removal) {
          result = result.then(function() {
            return coughDropExtras.storage.store('deletion', {store: store, id: record.id, storageId: (store + "_" + record.id)});
          });
        }

        result.then(function() {
          persistence.log = persistence.log || [];
          persistence.log.push({message: "Successfully removed object", object: obj, key: key});
          _this.removals.push({id: record.id});
        }, function(error) {
          persistence.errors = persistence.errors || [];
          persistence.errors.push({error: error, message: "Failed to remove object", object: obj, key: key});
        });
      }, 30);
    }

    return Ember.RSVP.resolve(obj);
  },
  store_eventually: function(store, obj, key) {
    persistence.eventual_store = persistence.eventual_store || [];
    persistence.eventual_store.push([store, obj, key, true]);
    if(!persistence.eventual_store_timer) {
      persistence.eventual_store_timer = Ember.run.later(persistence, persistence.next_eventual_store, 100);
    }
    return Ember.RSVP.resolve(obj);
  },
  refresh_after_eventual_stores: function() {
    if(persistence.eventual_store && persistence.eventual_store.length > 0) {
      persistence.refresh_after_eventual_stores.waiting = true;
    } else {
      // TODO: I can't figure out a reliable way to know for sure
      // when all the records can be looked up in the local store,
      // so I'm using timers for now. Luckily these lookups shouldn't
      // be very involved, especially once the record has been found.
      if(CoughDrop.Board) {
        Ember.run.later(CoughDrop.Board.refresh_data_urls, 2000);
      }
    }
  },
  next_eventual_store: function() {
    if(persistence.eventual_store_timer) {
      Ember.run.cancel(persistence.eventual_store_timer);
    }
    var args = (persistence.eventual_store || []).shift();
    if(args) {
      persistence.store.apply(persistence, args);
    } else if(persistence.refresh_after_eventual_stores.waiting) {
      persistence.refresh_after_eventual_stores.waiting = false;
      if(CoughDrop.Board) {
        CoughDrop.Board.refresh_data_urls();
      }
    }
    persistence.eventual_store_timer = Ember.run.later(persistence, persistence.next_eventual_store, 100);
  },
  store: function(store, obj, key, eventually) {
    // TODO: more nuanced wipe of known_missing would be more efficient
    persistence.known_missing = persistence.known_missing || {};
    persistence.known_missing[store] = {};

    var _this = this;

    return new Ember.RSVP.Promise(function(resolve, reject) {
      if(coughDropExtras && coughDropExtras.ready) {
        persistence.stores = persistence.stores || [];
        var promises = [];
        var store_method = eventually ? persistence.store_eventually : persistence.store;
        if(valid_stores.indexOf(store) != -1) {
          var record = {raw: (obj[store] || obj)};
          if(store == 'settings') {
            record.storageId = key;
          }
          if(store == 'user') {
            record.raw.key = record.raw.user_name;
          }
          record.id = record.raw.id || key;
          record.key = record.raw.key;
          record.tmp_key = record.raw.tmp_key;
          record.changed = !!record.raw.changed;


          var store_promise = coughDropExtras.storage.store(store, record, key).then(function() {
            if(store == 'user' && key == 'self') {
              return store_method('settings', {id: record.id}, 'selfUserId').then(function() {
                return Ember.RSVP.resolve(record.raw);
              }, function() {
                return Ember.RSVP.reject({error: "selfUserId not persisted"});
              });
            } else {
              return Ember.RSVP.resolve(record.raw);
            }
          });
          store_promise.then(null, function() { });
          promises.push(store_promise);
        }
        if(store == 'board' && obj.images) {
          obj.images.forEach(function(img) {
            promises.push(store_method('image', img, null));
          });
        }
        if(store == 'board' && obj.sounds) {
          obj.sounds.forEach(function(snd) {
            promises.push(store_method('sound', snd, null));
          });
        }
        Ember.RSVP.all(promises).then(function() {
          persistence.stores.push({object: obj});
          persistence.log = persistence.log || [];
          persistence.log.push({message: "Successfully stored object", object: obj, store: store, key: key});
        }, function(error) {
          persistence.errors = persistence.errors || [];
          persistence.errors.push({error: error, message: "Failed to store object", object: obj, store: store, key: key});
        });
        promises.forEach(function(p) { p.then(null, function() { }); });
      }

      resolve(obj);
    });
  },
  find_url: function(url, type) {
    if(this.url_cache && this.url_cache[url]) {
      return Ember.RSVP.resolve(this.url_cache[url]);
    } else if(this.url_uncache && this.url_uncache[url]) {
      var _this = this;
      var find = this.find('dataCache', url);
      return find.then(function(data) {
        _this.url_cache = _this.url_cache || {};
        var file_missing = _this.url_cache[url] === false;
        if(data.local_url) {
          if(data.local_filename) {
            if(type == 'image' && _this.image_filename_cache && _this.image_filename_cache[data.local_filename]) {
              _this.url_cache[url] = capabilities.storage.fix_url(data.local_url);
              return _this.url_cache[url];
            } else if(type == 'sound' && _this.sound_filename_cache && _this.sound_filename_cache[data.local_filename]) {
              _this.url_cache[url] = capabilities.storage.fix_url(data.local_url);
              return _this.url_cache[url];
            } else {
              // confirm that the file is where it's supposed to be before returning
              return new Ember.RSVP.Promise(function(file_url_resolve, file_url_reject) {
                // apparently file system calls are really slow on ios
                if(data.local_url) {
                  var local_url = capabilities.storage.fix_url(data.local_url);
                  _this.url_cache[url] = local_url;
                  file_url_resolve(local_url);
                } else {
                  if(file_missing) {
                    capabilities.storage.get_file_url(type, data.local_filename).then(function(local_url) {
                      var local_url = capabilities.storage.fix_url(local_url);
                      _this.url_cache[url] = local_url;
                      file_url_resolve(local_url);
                    }, function() {
                      if(data.data_uri) {
                        file_url_resolve(data.data_uri);
                      } else {
                        file_url_reject({error: "missing local file"});
                      }
                    });
                  } else {
                    var local_url = capabilities.storage.fix_url(data.local_filename);
                    _this.url_cache[url] = local_url;
                    file_url_resolve(local_url);
                  }
                }
              });
            }
          }
          data.local_url = capabilities.storage.fix_url(data.local_url);
          _this.url_cache[url] = data.local_url;
          return data.local_url || data.data_uri;
        } else if(data.data_uri) {
          // methinks caching data URIs would fill up memory mighty quick, so let's not cache
          return data.data_uri;
        } else {
          return Ember.RSVP.reject({error: "no data URI or filename found for cached URL"});
        }
      });
    } else {
      return Ember.RSVP.reject({error: 'url not in storage'});
    }
  },
  prime_caches: function(check_file_system) {
    var _this = this;
    _this.url_cache = _this.url_cache || {};
    _this.url_uncache = _this.url_uncache || {};
    _this.image_filename_cache = _this.image_filename_cache || {};
    _this.sound_filename_cache = _this.sound_filename_cache || {};

    var prime_promises = [];
    if(_this.get('local_system.available') && _this.get('local_system.allowed') && stashes.get('auth_settings')) {
    } else {
      return Ember.RSVP.reject({error: 'not enabled or no user set'});
    }

    prime_promises.push(new Ember.RSVP.Promise(function(res, rej) {
      // apparently file system calls are really slow on ios
      if(!check_file_system) { return res([]); }
      capabilities.storage.list_files('image').then(function(images) {
        images.forEach(function(image) {
          _this.image_filename_cache[image] = true;
        });
        res(images);
      }, function(err) { rej(err); });
    }));
    prime_promises.push(new Ember.RSVP.Promise(function(res, rej) {
      // apparently file system calls are really slow on ios
      if(!check_file_system) { return res([]); }
      capabilities.storage.list_files('sound').then(function(sounds) {
        sounds.forEach(function(sound) {
          _this.sound_filename_cache[sound] = true;
        });
        res(sounds);
      }, function(err) { rej(err); });
    }));
    return Ember.RSVP.all_wait(prime_promises).then(function() {
      return coughDropExtras.storage.find_all('dataCache').then(function(list) {
        var promises = [];
        list.forEach(function(item) {
          if(item.data && item.data.raw && item.data.raw.url && item.data.raw.type && item.data.raw.local_filename) {
            _this.url_cache[item.data.raw.url] = null;
            if(item.data.raw.type == 'image' && item.data.raw.local_url && _this.image_filename_cache && _this.image_filename_cache[item.data.raw.local_filename]) {
              _this.url_cache[item.data.raw.url] = capabilities.storage.fix_url(item.data.raw.local_url);
            } else if(item.data.raw.type == 'sound' && item.data.raw.local_url && _this.sound_filename_cache && _this.sound_filename_cache[item.data.raw.local_filename]) {
              _this.url_cache[item.data.raw.url] = capabilities.storage.fix_url(item.data.raw.local_url);
            } else {
              // apparently file system calls are really slow on ios (and android)
              if(!check_file_system) {
                _this.url_cache[item.data.raw.url] = capabilities.storage.fix_url(item.data.raw.local_url);
              } else {
                promises.push(new Ember.RSVP.Promise(function(res, rej) {
                  capabilities.storage.get_file_url(item.data.raw.type, item.data.raw.local_filename).then(function(local_url) {
                    local_url = capabilities.storage.fix_url(local_url);
                    _this.url_cache[item.data.raw.url] = local_url;
                    res(local_url);
                  }, function(err) {
                    _this.url_cache[item.data.raw.url] = false;
                    rej(err);
                  });
                }));
              }
            }
          } else if(item.data && item.data.raw && item.data.raw.url) {
            _this.url_uncache[item.data.raw.url] = true;
          }
        });
        return Ember.RSVP.all_wait(promises).then(function() {
          return list;
        });
      });
    });
  },
  url_cache: {},
  store_url: function store_url(url, type, keep_big, force_reload) {
    persistence.urls_to_store = persistence.urls_to_store || [];
    var defer = Ember.RSVP.defer();
    var opts = {
      url: url,
      type: type,
      keep_big: keep_big,
      force_reload: force_reload,
      defer: defer
    };
    persistence.urls_to_store.push(opts);
    if(!persistence.storing_urls) {
      persistence.storing_url_watchers = 0;
      persistence.storing_urls = function() {
        if(persistence.urls_to_store && persistence.urls_to_store.length > 0) {
          var opts = persistence.urls_to_store.shift();
          persistence.store_url_now(opts.url, opts.type, opts.keep_big, opts.force_reload).then(function(res) {
            opts.defer.resolve(res);
            persistence.storing_urls();
          }, function(err) {
            opts.defer.reject(err);
            persistence.storing_urls();
          });
        } else {
          persistence.storing_url_watchers--;
        }
      };
    }
    var max_watchers = 3;
    if(capabilities.mobile) {
      max_watchers = 2;
      if(capabilities.system == 'Android') {
        max_watchers = 1;
      }
    }
    if(persistence.storing_url_watchers < max_watchers) {
      persistence.storing_url_watchers++;
      persistence.storing_urls();
    }
    return defer.promise;
  },
  store_url_now: function(url, type, keep_big, force_reload) {
    if(!type) { return Ember.RSVP.reject('type required for storing'); }
    if(!url) { console.error('url not provided'); return Ember.RSVP.reject('url required for storing'); }
    if(!window.coughDropExtras || !window.coughDropExtras.ready || url.match(/^data:/) || url.match(/^file:/)) {
      return Ember.RSVP.resolve({
        url: url,
        type: type
      });
    }
    return new Ember.RSVP.Promise(function(resolve, reject) {
      var lookup = Ember.RSVP.reject();

      var match = url.match(/opensymbols\.s3\.amazonaws\.com/) || url.match(/s3\.amazonaws\.com\/opensymbols/) ||
                  url.match(/coughdrop-usercontent\.s3\.amazonaws\.com/) || url.match(/s3\.amazonaws\.com\/coughdrop-usercontent/);

      if(capabilities.installed_app) { match = true; }
      // TODO: need a clean way to not be quite so eager about downloading
      // images that we're pretty sure haven't changed, even when force=true.
      // Really this was just added in case of corruption issues, or in
      // case images/sounds get saved with bad filenames and need to
      // be repaired.
      if(match && !force_reload) {
        // skip the remote request if it's stored locally from a location we
        // know won't ever modify static assets
        lookup = lookup.then(null, function() {
          return persistence.find('dataCache', url).then(function(data) {
            return Ember.RSVP.resolve(data);
          });
        });
      }

      if(match && window.FormData) {
        // try avoiding the proxy if we know the resource is CORS-enabled. Have to fall
        // back to plain xhr in order to get blob response
        lookup = lookup.then(null, function() {
          return new Ember.RSVP.Promise(function(xhr_resolve, xhr_reject) {
            var xhr = new XMLHttpRequest();
            xhr.addEventListener('load', function(r) {
              if(xhr.status == 200) {
                contentGrabbers.read_file(xhr.response).then(function(s) {
                  xhr_resolve({
                    url: url,
                    type: type,
                    content_type: xhr.getResponseHeader('Content-Type'),
                    data_uri: s.target.result
                  });
                }, function() {
                  xhr_reject({cors: true, error: 'URL processing failed'});
                });
              } else {
                console.log("COUGHDROP: CORS request probably failed");
                xhr_reject({cors: true, error: 'URL lookup failed with ' + xhr.status});
              }
            });
            xhr.addEventListener('error', function() {
              xhr_reject({cors: true, error: 'URL lookup error'});
            });
            xhr.addEventListener('abort', function() { xhr_reject({cors: true, error: 'URL lookup aborted'}); });
            console.log("trying CORS request for " + url);
            // Adding the query parameter because I suspect that if a URL has already
            // been retrieved by the browser, it's not sending CORS headers on the
            // follow-up request, maybe?
            xhr.open('GET', url + "?cr=1");
            xhr.responseType = 'blob';
            xhr.send(null);
          });
        });
      }

      var fallback = lookup.then(null, function(res) {
        if(res && res.error && res.cors) {
          console.error("CORS request error: " + res.error);
        }
        var external_proxy = Ember.RSVP.reject();
        if(window.symbol_proxy_key) {
          external_proxy = persistence.ajax('https://www.opensymbols.org/api/v1/symbols/proxy?url=' + encodeURIComponent(url) + '&access_token=' + window.symbol_proxy_key, {type: 'GET'}).then(function(data) {
            var object = {
              url: url,
              type: type,
              content_type: data.content_type,
              data_uri: data.data
            };
            return Ember.RSVP.resolve(object);
          });
        }
        return external_proxy.then(null, function() {
          return persistence.ajax('/api/v1/search/proxy?url=' + encodeURIComponent(url), {type: 'GET'}).then(function(data) {
            var object = {
              url: url,
              type: type,
              content_type: data.content_type,
              data_uri: data.data
            };
            return Ember.RSVP.resolve(object);
          }, function(xhr) {
            reject({error: "URL lookup failed during proxy for " + url});
          });
        });
      });

      var size_image = fallback.then(function(object) {
        if(type != 'image' || capabilities.system != "Android" || keep_big) {
          return object;
        } else {
          return contentGrabbers.pictureGrabber.size_image(object.url, 50).then(function(res) {
            if(res.url && res.url.match(/^data/)) {
              object.data_uri = res.url;
              object.content_type = (res.url.split(/:/)[1] || "").split(/;/)[0] || "image/png";
            }
            return object;
          }, function() {
            return Ember.RSVP.resolve(object);
          });
        }
      });

      size_image.then(function(object) {
        if(persistence.get('local_system.available') && persistence.get('local_system.allowed') && stashes.get('auth_settings')) {
          if(object.data_uri) {
            var local_system_filename = object.local_filename;
            if(!local_system_filename) {
              var file_code = 0;
              for(var idx = 0; idx < url.length; idx++) { file_code = file_code + url.charCodeAt(idx); }
              var pieces = url.split(/\?/)[0].split(/\//);
              var extension = contentGrabbers.file_type_extensions[object.content_type];
              if(!extension) {
                if(object.content_type.match(/^image\//) || object.content_type.match(/^audio\//)) {
                  extension = "." + object.content_type.split(/\//)[1].split(/\+/)[0];
                }
              }
              var url_extension = pieces[pieces.length - 1].split(/\./).pop();
              if(!extension && url_extension) {
                extension = "." + url_extension;
              }
              extension = extension || ".png";
              local_system_filename = (file_code % 10000).toString() + "0000." + pieces.pop() + "." + file_code.toString() + extension;
            }
            var svg = null;
            if(object.data_uri.match(/svg/)) {
              try {
                svg = atob(object.data_uri.split(/,/)[1]);
                if((svg.match(/<svg/) || []).length > 1) { console.error('data_uri had double-content'); }
              } catch(e) { }
            }
            return new Ember.RSVP.Promise(function(write_resolve, write_reject) {
              var blob = contentGrabbers.data_uri_to_blob(object.data_uri);
              if(svg && blob.size > svg.length) { console.error('blob generation caused double-content'); }
              capabilities.storage.write_file(type, local_system_filename, blob).then(function(res) {
                object.data_uri = null;
                object.local_filename = local_system_filename;
                object.local_url = res;
                object.persisted = true;
                write_resolve(persistence.store('dataCache', object, object.url));
              }, function(err) { write_reject(err); });
            });
          } else {
            return object;
          }
        } else {
          if(!object.persisted) {
            object.persisted = true;
            return persistence.store('dataCache', object, object.url);
          } else {
            return object;
          }
        }
      }).then(function(object) {
        resolve(object);
      }, function() {
        reject({error: "saving to data cache failed"});
      });
    });
  },
  enable_wakelock: function() {
    if(this.get('syncing')) {
      capabilities.wakelock('sync', true);
    } else {
      capabilities.wakelock('sync', false);
    }
  }.observes('syncing'),
  syncing: function() {
    return this.get('sync_status') == 'syncing';
  }.property('sync_status'),
  sync_failed: function() {
    return this.get('sync_status') == 'failed';
  }.property('sync_status'),
  sync_succeeded: function() {
    return this.get('sync_status') == 'succeeded';
  }.property('sync_status'),
  update_sync_progress: function() {
    var progresses = persistence.get('sync_progress.progress_for');
    var visited = 0;
    var to_visit = 0;
    for(var idx in progresses) {
      visited = visited + progresses[idx].visited;
      to_visit = to_visit + progresses[idx].to_visit;
    }
    if(persistence.get('sync_progress')) {
      persistence.set('sync_progress.visited', visited);
      persistence.set('sync_progress.to_visit', to_visit);
      persistence.set('sync_progress.total', to_visit + visited);
    }
  },
  sync: function(user_id, force, ignore_supervisees) {
    if(!window.coughDropExtras || !window.coughDropExtras.ready) {
      return new Ember.RSVP.Promise(function(wait_resolve, wait_reject) {
        coughDropExtras.advance.watch('all', function() {
          wait_resolve(persistence.sync(user_id, force, ignore_supervisees));
        });
      });
    }

    console.log('syncing for ' + user_id);
    if(this.get('online')) {
      stashes.push_log();
    }

    this.set('sync_status', 'syncing');
    var synced_boards = [];
    // TODO: this could move to bg.js, that way it can run in the background
    // even if the app itself isn't running. whaaaat?! yeah.

    // TODO: there should be a user preference to say, when I sync as 'self'
    // go ahead and sync all the boards for all my linked users as well.

    var sync_promise = new Ember.RSVP.Promise(function(sync_resolve, sync_reject) {
      if(!user_id) {
        sync_reject({error: "failed to retrieve user, missing id"});
      }

      var prime_caches = persistence.prime_caches(true).then(null, function() { return Ember.RSVP.resolve(); });

      var find_user = prime_caches.then(function() {
        return CoughDrop.store.findRecord('user', user_id).then(null, function() {
          sync_reject({error: "failed to retrieve user details"});
        });
      });

      var confirm_quota_for_user = find_user.then(function(user) {
        if(user) {
          if(persistence.get('local_system.available') && user.get('preferences.home_board') &&
                    !persistence.get('local_system.allowed') && persistence.get('local_system.requires_confirmation') &&
                    stashes.get('allow_local_filesystem_request')) {
            return new Ember.RSVP.Promise(function(check_resolve, check_reject) {
              capabilities.storage.root_entry().then(function() {
                persistence.set('local_system.allowed', true);
                check_resolve(user);
              }, function() {
                persistence.set('local_system.available', false);
                persistence.set('local_system.allowed', false);
                check_resolve(user);
              });
            });
          }
        }
        return user;
      });

      confirm_quota_for_user.then(function(user) {
        if(user) {
          user_id = user.get('id');
        }
        // TODO: also download all the user's personally-created boards

        var sync_log = [];

        var sync_promises = [];

        // Step 0: If extras isn't ready then there's nothing else to do
        if(!window.coughDropExtras || !window.coughDropExtras.ready) {
          sync_promises.push(Ember.RSVP.reject({error: "extras not ready"}));
        }
        if(!capabilities.db) {
          sync_promises.push(Ember.RSVP.reject({error: "db not initialized"}));
        }

        // Step 1: If online
        // if there are any pending transactions, save them one by one
        // (needs to also support s3 uploading for locally-saved images/sounds)
        // (needs to be smart about handling conflicts)
        // http://www.cs.tufts.edu/~nr/pubs/sync.pdf
        sync_promises.push(persistence.sync_changed());

        var importantIds = [];

        // Step 2: If online
        // get the latest user profile information and settings
        sync_promises.push(persistence.sync_user(user, importantIds));

        // Step 3: If online
        // check if the board set has changed at all, and if so
        // (or force == true) pull it all down locally
        // (add to settings.importantIds list)
        // (also download through proxy any image data URIs needed for board set)
        sync_promises.push(persistence.sync_boards(user, importantIds, synced_boards, force));

        // Step 4: If user has any supervisees, sync them as well
        if(user && user.get('supervisees') && !ignore_supervisees) {
          sync_promises.push(persistence.sync_supervisees(user, force));
        }

        // Step 5: Cache needed sound files
        sync_promises.push(speecher.load_beep());

        // reject on any errors
        Ember.RSVP.all_wait(sync_promises).then(function() {
          // Step 4: If online
          // store the list ids to settings.importantIds so they don't get expired
          // even after being offline for a long time. Also store lastSync somewhere
          // that's easy to get to (localStorage much?) for use in the interface.
          persistence.important_ids = importantIds.uniq();
          persistence.store('settings', {ids: persistence.important_ids}, 'importantIds').then(function(r) {
            persistence.refresh_after_eventual_stores();
            sync_resolve(sync_log);
          }, function() {
            persistence.refresh_after_eventual_stores();
            sync_reject(arguments);
          });
        }, function() {
          persistence.refresh_after_eventual_stores();
          sync_reject.apply(null, arguments);
        });
      });

    }).then(function() {
      // TODO: some kind of alert with a "reload" option, since we potentially
      // just changed data out from underneath what's showing in the UI

      // make a list of all buttons in the set so we can figure out the button
      // sequence needed to get from A to B
      var track_buttons = persistence.sync_buttons(synced_boards);

      var complete_sync = track_buttons.then(function() {
        var last_sync = (new Date()).getTime() / 1000;
        if(persistence.get('sync_progress.root_user') == user_id) {
          persistence.set('sync_progress', null);
          persistence.set('sync_status', 'succeeded');
          console.log('synced!');
          persistence.store('settings', {last_sync: last_sync}, 'lastSync').then(function(res) {
            persistence.set('last_sync_at', res.last_sync);
          }, function() {
            debugger;
          });
        }
        return Ember.RSVP.resolve(last_sync);
      });
      return complete_sync;
    }, function(err) {
      if(persistence.get('sync_progress.root_user') == user_id) {
        persistence.set('sync_progress', null);
        persistence.set('sync_status', 'failed');
        persistence.set('sync_status_error', null);
        if(err.board_unauthorized) {
          persistence.set('sync_status_error', i18n.t('board_unauthorized', "One or more boards are private"));
        } else if(!persistence.get('online')) {
          persistence.set('sync_status_error', i18n.t('not_online', "Must be online to sync"));
        }
        if(err && err.error) {
          modal.error(err.error);
        }
        console.log(err);
      }
      return Ember.RSVP.reject(err);
    });
    this.set('sync_promise', sync_promise);
    return sync_promise;
  },
  sync_buttons: function(synced_boards) {
    return Ember.RSVP.resolve();
//     return new Ember.RSVP.Promise(function(buttons_resolve, buttons_reject) {
//       var buttons_in_sequence = [];
//       synced_boards.forEach(function(board) {
//         var images = board.get('local_images_with_license');
//         // TODO: add them in "proper" order, whatever that means
//         board.get('buttons').forEach(function(button) {
//           button.board_id = board.get('id');
//           if(button.load_board) {
//             button.load_board_id = button.load_board.id;
//           }
//           var image = images.find(function(i) { return i.get('id') == button.image_id; });
//           if(image) {
//             button.image = image.get('url');
//           }
//           // TODO: include the image here, if it makes things easier. Sync
//           // can be a more expensive process than find_button should be..
//           buttons_in_sequence.push(button);
//         });
//       });
//       persistence.store('settings', {list: buttons_in_sequence}, 'syncedButtons').then(function(res) {
//         buttons_resolve();
//       }, function() {
//         buttons_reject();
//       });
//     });
  },
  sync_supervisees: function(user, force) {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      var supervisee_promises = [];
      user.get('supervisees').forEach(function(supervisee) {
        var find_supervisee = CoughDrop.store.findRecord('user', supervisee.id).then(function(record) {
          if(!record.get('fresh') || force) {
            return record.reload();
          } else {
            return record;
          }
        });

        var sync_supervisee = find_supervisee.then(function(supervisee_user) {
          if(supervisee_user.get('permissions.supervise')) {
            console.log('syncing supervisee: ' + supervisee.user_name + " " + supervisee.id);
            return persistence.sync(supervisee.id, force, true);
          } else {
            return Ember.RSVP.reject({error: "supervise permission missing"});
          }
        });
        var complete = sync_supervisee.then(null, function(err) {
          console.log(err);
          console.error("supervisee sync failed");
          modal.warning(i18n.t('supervisee_sync_failed', "Couldn't sync boards for supervisee \"" + supervisee.user_name + "\""));
          return Ember.RSVP.resolve({});
        });
        supervisee_promises.push(complete);
      });
      Ember.RSVP.all_wait(supervisee_promises).then(function() {
        resolve(user.get('supervisees'));
      }, function() {
        reject.apply(null, arguments);
      });
    });
  },
  sync_boards: function(user, importantIds, synced_boards, force) {
    var get_revisions = persistence.find('settings', 'synced_full_set_revisions').then(function(res) {
      return res;
    }, function() {
      return Ember.RSVP.resolve({});
    });

    var sync_all_boards = get_revisions.then(function(full_set_revisions) {
      return new Ember.RSVP.Promise(function(resolve, reject) {
        var to_visit_boards = [];
        if(user.get('preferences.home_board.id')) {
          var board = user.get('preferences.home_board');
          board.depth = 0;
          to_visit_boards.push(board);
        }
        if(user.get('preferences.sidebar_boards')) {
          user.get('preferences.sidebar_boards').forEach(function(b) {
            if(b.key) {
              to_visit_boards.push({key: b.key, depth: 1, image: b.image});
            }
          });
        }
        var safely_cached_boards = {};
        var visited_boards = [];
        if(!persistence.get('sync_progress.root_user')) {
          persistence.set('sync_progress', {
            root_user: user.get('id'),
            progress_for: {
            }
          });
          persistence.get('sync_progress.progress_for')[user.get('id')] = {
            visited: visited_boards.length,
            to_visit: to_visit_boards.length
          };
          persistence.update_sync_progress();
        }
        var board_load_promises = [];
        var dead_thread = false;
        function nextBoard(defer) {
          if(dead_thread) { defer.reject({error: "someone else failed"}); return; }
          var p_for = persistence.get('sync_progress.progress_for');
          if(p_for) {
            p_for[user.get('id')] = {
              visited: visited_boards.length,
              to_visit: to_visit_boards.length
            };
          }
          persistence.update_sync_progress();
          var next = to_visit_boards.shift();
          var id = next && (next.id || next.key);
          var key = next && next.key;
          if(next && next.depth < 20 && id && !visited_boards.find(function(i) { return i == id; })) {
            var local_full_set_revision = null;
            var peeked = CoughDrop.store.peekRecord('board', id);
            var key_for_id = id.match(/\//);
            if(peeked && !peeked.get('permissions')) { peeked = null; }
            var find_board = CoughDrop.store.findRecord('board', id);
            find_board = find_board.then(function(record) {
              importantIds.push('board_' + id);
              if(peeked || key_for_id || !record.get('fresh')) {
                local_full_set_revision = record.get('full_set_revision');
                // If the board is in the list of already-up-to-date, don't call reload
                if(safely_cached_boards[id]) {
                  return record;
                } else {
                  return record.reload();
                }
              } else {
                return record;
              }
            });

            find_board.then(function(board) {
              board.load_button_set();
              var visited_board_promises = [];
              var safely_cached = !!safely_cached_boards[board.id];
              // If the retrieved board's revision matches the synced cache's revision,
              // then this board and all its children should be already in the db.
              safely_cached = safely_cached || (full_set_revisions[board.get('id')] && board.get('full_set_revision') == full_set_revisions[board.get('id')]);
              if(force) { safely_cached = false; }
              if(safely_cached) {
                console.log("this board (" + board.get('key') + ") has already been cached locally");
              }
              synced_boards.push(board);
              visited_boards.push(id);

              // TODO: if not set to force=true, don't re-download already-stored icons from
              // possibly-changing URLs
              if(board.get('icon_url_with_fallback').match(/^http/)) {
                visited_board_promises.push(persistence.store_url(board.get('icon_url_with_fallback'), 'image', false, force).then(null, function() {
                  return Ember.RSVP.reject({error: "icon url failed to sync, " + board.get('icon_url_with_fallback')});
                }));
                importantIds.push("dataCache_" + board.get('icon_url_with_fallback'));
              }

              if(next.image) {
                visited_board_promises.push(persistence.store_url(next.image, 'image', false, force).then(null, function() {
                  return Ember.RSVP.reject({error: "sidebar icon url failed to sync, " + next.image});
                }));
                importantIds.push("dataCache_" + next.image);
              }

              board.get('local_images_with_license').forEach(function(image) {
                importantIds.push("image_" + image.get('id'));
                // TODO: don't re-request URLs that are already in the cache and most likely haven't changed
                var keep_big = !!(board.get('grid.rows') < 3 || board.get('grid.columns') < 6);
                if(image.get('url') && image.get('url').match(/^http/)) {
                  visited_board_promises.push(persistence.store_url(image.get('url'), 'image', keep_big, force).then(null, function() {
                    return Ember.RSVP.reject({error: "button image failed to sync, " + image.get('url')});
                  }));
                  importantIds.push("dataCache_" + image.get('url'));
                }
              });
              board.get('local_sounds_with_license').forEach(function(sound) {
                importantIds.push("sound_" + sound.get('id'));
                if(sound.get('url') && sound.get('url').match(/^http/)) {
                   visited_board_promises.push(persistence.store_url(sound.get('url'), 'sound', false, force).then(null, function() {
                    return Ember.RSVP.reject({error: "button sound failed to sync, " + sound.get('url')});
                   }));
                  importantIds.push("dataCache_" + sound.get('url'));
                }
              });
              board.get('linked_boards').forEach(function(board) {
                // don't re-visit if we've already grabbed it for this sync
                var already_visited = visited_boards.find(function(i) { return i == board.id || i == board.key; });
                // don't add to the list if already planning to visit (and either
                // the planned visit doesn't have link_disabled flag or the
                // two entries match for the link_disabled flag)
                var already_going_to_visit = to_visit_boards.find(function(b) { return (b.id == board.id || b.key == board.key) && (!board.link_disabled || board.link_disabled == b.link_disabled); });

                if(!already_visited && !already_going_to_visit) {
                  to_visit_boards.push({id: board.id, key: board.key, depth: next.depth + 1, link_disabled: board.link_disabled});
                }
                if(safely_cached) {
                  // (this check is hypothesizing it's possible to lose some data via leakage
                  // in the indexeddb, and really should never get an error result)
                  visited_board_promises.push(persistence.find('board', board.id).then(function(b) {
                    var necessary_finds = [];
                    var tmp_board = CoughDrop.store.createRecord('board', Ember.$.extend({}, b, {id: null}));
                    tmp_board.get('used_buttons').forEach(function(button) {
                      if(button.image_id) {
                        necessary_finds.push(persistence.find('image', button.image_id).then(function(image) {
                          return persistence.find_url(image.url);
                        }));
                      }
                      if(button.sound_id) {
                        necessary_finds.push(persistence.find('sound', button.sound_id).then(function(sound) {
                          return persistence.find_url(sound.url);
                        }));
                      }
                    });
                    return Ember.RSVP.all_wait(necessary_finds).then(function() {
                      safely_cached_boards[board.id] = true;
                    }, function(error) {
                      console.log(error);
                      console.error("should have been safely cached, but board content wasn't in db:" + board.id);
                      return Ember.RSVP.resolve();
                    });
                  }, function() {
                    console.error("should have been safely cached, but board wasn't in db:" + board.id);
                    return Ember.RSVP.resolve();
                  }));
                }
              });

              Ember.RSVP.all_wait(visited_board_promises).then(function() {
                full_set_revisions[board.get('id')] = board.get('full_set_revision');
                Ember.run.later(function() {
                  nextBoard(defer);
                }, 150);
              }, function(err) {
                var msg = "board " + (key || id) + " failed to sync completely";
                if(typeof err == 'string') {
                  msg = msg + ": " + err;
                } else if(err && err.error) {
                  msg = msg + ": " + err.error;
                }
                defer.reject({error: msg});
              });
            }, function(err) {
              var board_unauthorized = (err && err.error == "Not authorized");
              if(next.link_disabled && board_unauthorized) {
                // TODO: if a link is disabled, can we get away with ignoring an unauthorized board?
                // Prolly, since they won't be using that board anyway without an edit.
                Ember.run.later(function() {
                  nextBoard(defer);
                }, 150);
              } else {
                defer.reject({error: "board " + (key || id) + " failed retrieval for syncing", board_unauthorized: board_unauthorized});
              }
            });
          } else if(!next) {
            // TODO: mark this defer's promise as waiting (needs to be unmarked at each
            // nextBoard call), then set a longer timeout before calling nextBoard,
            // and only resolve when *all* the promises are waiting.
            defer.resolve();
          } else {
            Ember.run.later(function() {
              nextBoard(defer);
            }, 50);
          }
        }
        // threaded lookups, though a polling pool would probably be better since all
        // could resolve and then the final one finds a ton more boards
        for(var threads = 0; threads < 2; threads++) {
          var defer = Ember.RSVP.defer();
          nextBoard(defer);
          board_load_promises.push(defer.promise);
        }
        Ember.RSVP.all_wait(board_load_promises).then(function() {
          resolve(full_set_revisions);
        }, function(err) {
          dead_thread = true;
          reject.apply(null, arguments);
        });
      });
    });

    return sync_all_boards.then(function(full_set_revisions) {
      return persistence.store('settings', full_set_revisions, 'synced_full_set_revisions');
    });
  },
  sync_user: function(user, importantIds) {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      importantIds.push('user_' + user.get('id'));
      var find_user = user.reload().then(function(u) {
        return Ember.RSVP.resolve(u);
      }, function() {
        reject({error: "failed to retrieve latest user details"});
      });

      // also download the latest avatar as a data uri
      var save_avatar = find_user.then(function(user) {
        // is this also a user object? does user = u work??
        var url = user.get('avatar_url');
        return persistence.store_url(url, 'image');
      });

      save_avatar.then(function(object) {
        importantIds.push("dataCache_" + object.url);
        resolve();
      }, function() {
        reject({error: "failed to save user avatar"});
      });
    });
  },
  sync_changed: function() {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      var changed = persistence.find_changed().then(null, function() {
        reject({error: "failed to retrieve list of changed records"});
      });

      changed.then(function(list) {
        var update_promises = [];
        var tmp_id_map = {};
        var re_updates = [];
        // TODO: need to better handle errors with updates and deletes
        list.forEach(function(item) {
          if(item.store == 'deletion') {
            var promise = CoughDrop.store.findRecord(item.data.store, item.data.id).then(function(res) {
              res.deleteRecord();
              return res.save().then(function() {
                return persistence.remove(item.store, item.data);
              }, function() { debugger; });
            }, function() {
              // if it's already deleted, there's nothing for us to do
              return Ember.RSVP.resolve();
            });
            update_promises.push(promise);
          } else if(item.store == 'board' || item.store == 'image' || item.store == 'sound' || item.store == 'user') {
            var find_record = null;
            var object = item.data.raw[item.store] || item.data.raw;
            var tmp_id = null;
            if(object.id.match(/^tmp_/)) {
              tmp_id = object.id;
              object.id = null;
              find_record = Ember.RSVP.resolve(CoughDrop.store.createRecord(item.store, object));
            } else {
              find_record = CoughDrop.store.findRecord(item.store, object.id).then(null, function() {
                return Ember.RSVP.reject({error: "failed to retrieve " + item.store + " " + object.id + "for updating"});
              });
            }
            var save_item = find_record.then(function(record) {
              // TODO: check for conflicts before saving...
              record.setProperties(object);
              if(!record.get('id') && (item.store == 'image' || item.store == 'sound')) {
                record.set('data_url', object.data_url);
                return contentGrabbers.save_record(record).then(function() {
                  return record.reload();
                });
              } else {
                return record.save();
              }
            });

            var result = save_item.then(function(record) {
              if(item.store == 'board' && JSON.stringify(object).match(/tmp_/)) { // TODO: if item has temporary pointers
                re_updates.push([item, record]);
              }
              if(tmp_id) {
                tmp_id_map[tmp_id] = record;
                return persistence.remove(item.store, {}, tmp_id);
              }
              return Ember.RSVP.resolve();
            }, function() {
              return Ember.RSVP.reject({error: "failed to save " + item.store + " " + object.id});
            });

            update_promises.push(result);
          }
        });
        Ember.RSVP.all_wait(update_promises).then(function() {
          if(re_updates.length > 0) {
            var re_update_promises = [];
            re_updates.forEach(function(update) {
              var item = update[0];
              var record = update[1];
              if(item.store == 'board') {
                var buttons = record.get('buttons');
                if(buttons) {
                  for(var idx = 0; idx < buttons.length; idx++) {
                    var button = buttons[idx];
                    if(tmp_id_map[button.image_id]) {
                      button.image_id = tmp_id_map[button.image_id].get('id');
                    }
                    if(tmp_id_map[button.sound_id]) {
                      button.sound_id = tmp_id_map[button.sound_id].get('id');
                    }
                    if(button.load_board && tmp_id_map[button.load_board.id]) {
                      var board = tmp_id_map[button.load_board.id];
                      button.load_board = {
                        id: board.get('id'),
                        key: board.get('key')
                      };
                    }
                    buttons[idx] = button;
                  }
                }
                record.set('buttons', buttons);
              } else {
                debugger;
              }
              // TODO: update any tmp_ids from item in record using tmp_id_map
              re_update_promises.push(record.save());
            });
            Ember.RSVP.all_wait(re_update_promises).then(function() {
              resolve();
            }, function(err) {
              reject(err);
            });
          } else {
            resolve();
          }
        }, function(err) {
          reject(err);
        });
      });
    });
  },
  temporary_id: function() {
    return "tmp_" + Math.random().toString() + (new Date()).getTime().toString();
  },
  convert_model_to_json: function(store, modelName, record) {
    var type = store.modelFor(modelName);
    var data = {};
    var serializer = store.serializerFor(type.modelName);

    var snapshot = record; //._createSnapshot();
    serializer.serializeIntoHash(data, type, snapshot, { includeId: true });

    // TODO: mimic any server-side changes that need to happen to make the record usable
    if(!data[type.modelName].id) {
      data[type.modelName].id = persistence.temporary_id();
    }
    if(type.mimic_server_processing) {
      data = type.mimic_server_processing(record, data);
    }

    return data;
  },
  offline_reject: function() {
    return Ember.RSVP.reject({offline: true, error: "not online"});
  },
  meta: function(store, obj) {
    if(obj && obj.get('meta')) {
      return obj.get('meta');
    } else if(obj && obj.get('id')) {
      var res = coughDropExtras.meta('GET', store, obj.get('id'));
      res = res || coughDropExtras.meta('PUT', store, obj.get('id'));
      res = res || coughDropExtras.meta('GET', store, obj.get('user_name') || obj.get('key'));
      return res;
    } else if(!obj) {
      return coughDropExtras.meta('POST', store, null);
    }
    return null;
  },
  ajax: function() {
    if(this.get('online')) {
      var ajax_args = arguments;
      // TODO: is this wrapper necessary? what's it for? maybe can just listen on
      // global ajax for errors instead...
      return new Ember.RSVP.Promise(function(resolve, reject) {
        Ember.$.ajax.apply(null, ajax_args).then(function(data, message, xhr) {
          Ember.run(function() {
            if(data) {
              data.xhr = xhr;
            }
            resolve(data);
          });
        }, function(xhr) {
          // TODO: for some reason, safari returns the promise instead of the promise's
          // result to this handler. I'm sure it's something I'm doing wrong, but I haven't
          // been able to figure it out yet. This is a band-aid.
          if(xhr.then) { console.log("received the promise instead of the promise's result.."); }
          var promise = xhr.then ? xhr : Ember.RSVP.reject(xhr);
          promise.then(null, function(xhr) {
            if(false) { // TODO: check for offline error in xhr
              reject(xhr, {offline: true, error: "not online"});
            } else {
              reject(xhr);
            }
          });
        });
      });
    } else {
      return Ember.RSVP.reject(null, {offline: true, error: "not online"});
    }
  },
  on_connect: function() {
    stashes.set('online', this.get('online'));
    if(this.get('online') && (!CoughDrop.testing || CoughDrop.sync_testing)) {
      var _this = this;
      Ember.run.later(function() {
        // TODO: maybe do a quick xhr to a static asset to make sure we're for reals online?
        if(stashes.get('auth_settings')) {
          var synced = _this.get('last_sync_at') || 1;
          var now = (new Date()).getTime() / 1000;
          // if we haven't synced in 1 hour and we're online, do a background sync
          if((now - synced) > (60 * 60) && _this.get('online')) {
            _this.sync('self').then(null, function() { });
          }
        }
        _this.tokens = {};
        if(CoughDrop.session) {
          CoughDrop.session.restore(!persistence.get('browserToken'));
        }
      }, 500);
    }
  }.observes('online'),
  check_for_needs_sync: function() {
    var _this = this;
    if(stashes.get('auth_settings')) {
      var synced = _this.get('last_sync_at') || 1;
      var now = (new Date()).getTime() / 1000;
      // if we haven't synced in 12 hours and we're online, do a background sync
      if((now - synced) > (12 * 60 * 60) && persistence.get('online') && !Ember.testing && !persistence.get('syncing')) {
        persistence.sync('self').then(null, function() { });
      }
    }
  }.observes('refresh_stamp', 'last_sync_at'),
  check_for_sync_reminder: function() {
    var _this = this;
    if(stashes.get('auth_settings')) {
      var synced = _this.get('last_sync_at') || 1;
      var now = (new Date()).getTime() / 1000;
      // if we haven't synced in 14 days, remind to sync
      if((now - synced) > (14 * 24 * 60 * 60) && !Ember.testing) {
        persistence.set('sync_reminder', true);
      } else {
        persistence.set('sync_reminder', false);
      }
    } else {
      persistence.set('sync_reminder', false);
    }
  }.observes('refresh_stamp', 'last_sync_at')
}).create({online: (navigator.onLine)});
stashes.set('online', navigator.onLine);

window.addEventListener('online', function() {
  persistence.set('online', true);
});
window.addEventListener('offline', function() {
  persistence.set('online', false);
});
// Cordova notifies on the document object
document.addEventListener('online', function() {
  persistence.set('online', true);
});
document.addEventListener('offline', function() {
  persistence.set('online', false);
});

persistence.DSExtend = {
  find: function(store, type, id) {
    var _this = this;
    var _super = this.__nextSuper;

    var find = persistence.find(type.modelName, id, true);

    var full_id = type.modelName + "_" + id;
    if(persistence.force_reload == full_id) { find.then(null, function() { }); find = Ember.RSVP.reject(); }
    else if(!stashes.get('enabled')) { find.then(null, function() { }); find = Ember.RSVP.reject(); }

    return find.then(function(data) {
      data.meta = data.meta || {};
      data.meta.local_result = true;
      if(data[type.modelName] && data.meta && data.meta.local_result) {
        data[type.modelName].local_result = true;
      }
      coughDropExtras.meta_push({
        method: 'GET',
        model: type.modelName,
        id: id,
        meta: data.meta
      });
      return Ember.RSVP.resolve(data);
    }, function() {
      // TODO: records created locally but not remotely should have a tmp_* id
      if(persistence.get('online') && !id.match(/^tmp[_\/]/)) {
        persistence.remember_access('find', type.modelName, id);
        return _super.call(_this, store, type, id).then(function(record) {
          if(record[type.modelName]) {
            delete record[type.modelName].local_result;
            var now = (new Date()).getTime();
            record[type.modelName].retrieved = now;
            if(record.images) {
              record.images.forEach(function(i) { i.retrieved = now; });
            }
            if(record.sounds) {
              record.sounds.forEach(function(i) { i.retrieved = now; });
            }
          }
          var ref_id = null;
          if(type.modelName == 'user' && id == 'self') {
            ref_id = 'self';
          }
          return persistence.store_eventually(type.modelName, record, ref_id).then(function() {
            return Ember.RSVP.resolve(record);
          }, function() {
            return Ember.RSVP.reject({error: "failed to delayed-persist to local db"});
          });
        });
      } else {
        return persistence.offline_reject();
      }
    });
  },
  createRecord: function(store, type, obj) {
    var _this = this;
    if(persistence.get('online')) {
      var tmp_id = null, tmp_key = null;
//       if(obj.id && obj.id.match(/^tmp[_\/]/)) {
//         tmp_id = obj.id;
//         tmp_key = obj.attr('key');
//         var record = obj.record;
//         record.set('id', null);
//         obj = record._createSnapshot();
//       }
      return this._super(store, type, obj).then(function(record) {
        if(obj.record && obj.record.tmp_key) {
          record[type.modelName].tmp_key = obj.record.tmp_key;
        }
        return persistence.store(type.modelName, record).then(function() {
          if(tmp_id) {
            return persistence.remove('board', {}, tmp_id).then(function() {
              return Ember.RSVP.resolve(record);
            }, function() {
              return Ember.RSVP.reject({error: "failed to remove temporary record"});
            });
          } else {
            return Ember.RSVP.resolve(record);
          }
        }, function() {
          return Ember.RSVP.reject({error: "failed to create in local db"});
        });
      });
    } else {
      var record = persistence.convert_model_to_json(store, type.modelName, obj);
      record[type.modelName].changed = true;
      if(record[type.modelName].key && record[type.modelName].key.match(/^tmp_/)) {
        record[type.modelName].tmp_key = record[type.modelName].key;
      }
      // TODO: needs temporary id and replace mechanism once assigned a valid id
      // need raw object
      return persistence.store(type.modelName, record).then(function() {
        // TODO: what server-side computations are done that need to be recreated here, if any?
        return Ember.RSVP.resolve(record);
      }, function() {
        return persistence.offline_reject();
      });
    }
  },
  updateRecord: function(store, type, obj) {
    if(persistence.get('online')) {
      if(obj.id.match(/^tmp[_\/]/)) {
        return this.createRecord(store, type, obj);
      } else {
        return this._super(store, type, obj).then(function(record) {
          return persistence.store(type.modelName, record).then(function() {
            return Ember.RSVP.resolve(record);
          }, function() {
            return Ember.RSVP.reject({error: "failed to update to local db"});
          });
        });
      }
    } else {
      var record = persistence.convert_model_to_json(store, type.modelName, obj);
      record[type.modelName].changed = true;
      return persistence.store(type.modelName, record).then(function() {
        Ember.RSVP.resolve(record);
      }, function() {
        return persistence.offline_reject();
      });
    }
  },
  deleteRecord: function(store, type, obj) {
    // need raw object
    if(persistence.get('online')) {
      return this._super(store, type, obj).then(function(record) {
        return persistence.remove(type.modelName, record).then(function() {
          return Ember.RSVP.resolve(record);
        }, function() {
          return Ember.RSVP.reject({error: "failed to delete in local db"});
        });
      });
    } else {
      var record = persistence.convert_model_to_json(store, type.modelName, obj);
      return persistence.remove(type.modelName, record, null, true).then(function() {
        return Ember.RSVP.resolve(record);
      });
    }
  },
  findAll: function(store, type, id) {
    debugger;
  },
  query: function(store, type, query) {
    if(persistence.get('online')) {
      return this._super(store, type, query);
    } else {
      return persistence.offline_reject();
    }
  }
};
window.persistence = persistence;

export default persistence;
