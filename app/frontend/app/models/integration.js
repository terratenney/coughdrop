import Ember from 'ember';
import DS from 'ember-data';
import CoughDrop from '../app';
import persistence from '../utils/persistence';

CoughDrop.Integration = DS.Model.extend({
  name: DS.attr('string'),
  user_id: DS.attr('string'),
  custom_integration: DS.attr('boolean'),
  access_token: DS.attr('string'),
  truncated_access_token: DS.attr('string'),
  displayable_access_token: function() {
    return this.get('access_token') || this.get('truncated_access_token');
  }.property('access_token', 'truncated_access_token'),
  token: DS.attr('string'),
  truncated_token: DS.attr('string'),
  displayable_token: function() {
    return this.get('token') || this.get('truncated_token');
  }.property('token', 'truncated_token'),
});

export default CoughDrop.Integration;