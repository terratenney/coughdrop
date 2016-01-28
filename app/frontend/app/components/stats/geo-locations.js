import Ember from 'ember';
import CoughDrop from '../../app';
import i18n from '../../utils/i18n';

export default Ember.Component.extend({ 
  didInsertElement: function() {
    this.draw();
  },
  draw: function() {
    var stats = this.get('usage_stats');
    var elem = this.get('element').getElementsByClassName('geo_map')[0];
    
    CoughDrop.Visualizations.wait(function() {
      if(elem && stats && stats.get('geo_locations')) {
        var current_info = null;
        if(elem) {
          var map = new window.google.maps.Map(elem, {
            scrollwheel: false,
            maxZoom: 18
          });
          var markers = [];
          stats.get('geo_locations').forEach(function(location) {
            var title = i18n.t('session_count', "session", {count: location.total_sessions});
            var marker = new window.google.maps.Marker({
              position: new window.google.maps.LatLng(location.geo.latitude, location.geo.longitude),
              // TODO: https://developers.google.com/maps/documentation/javascript/examples/marker-animations-iteration
              // animation: window.google.maps.Animation.DROP,
              title: title
            });
            // TODO: popup information for each location
            marker.setMap(map);
            markers.push(marker);
          
            var dater = Ember.templateHelpers.date;
            var html = title + "<br/>" + dater(location.started_at, null) + 
                        " to <br/>" + dater(location.ended_at, null) + "<br/>" + 
                        "<a href='#' class='ember_link' data-location_id='" + location.id + "'>filter by this location</a>";
          
            var info = new window.google.maps.InfoWindow({
              content: html
            });
            window.google.maps.event.addListener(marker, 'click', function() {
              if(current_info) {
                current_info.close();
              }
              current_info = info;
              info.open(map, marker);
            });
          });
          var bounds = new window.google.maps.LatLngBounds();
          for(var i=0;i<markers.length;i++) {
           bounds.extend(markers[i].getPosition());
          }
          map.fitBounds(bounds);
        }
      }
    });
  }.observes('usage_stats.draw_id'),
  actions: {
    marker_link_select: function(data) {
      if(data.location_id) {
        this.sendAction('filter', 'location', data.location_id);
      }
    }
  }
});