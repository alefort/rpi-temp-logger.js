// Let's serve up the data file via json
var http = require( 'http' );
// Let's get the filestream api to write the temp data
var fs = require( 'fs' );
// Let's get the GPIO api for the rpi
var gpio = require( 'rpi-gpio' );
// Global request object for http get/post
var needle = require('needle');

var spiADC = {
	'options': {
		'channel': 0,
		'resistances_to_keep': 1000,
		'ignore_data_beyond_pct': 0.02,
		'calibration_adjustment': 0.5
	},
	'SPI': require( 'spi' ),
	'isOpen': false,	
	'device': '',
	'resistances': [],	
	'res_index': 0,	
	'series_resistor': 9860,
	'thermistor': {
		'nominal_resistance': 10000,		
		'nominal_temp': 25,
		'bcoefficient': 3950
	},	
	open: function(){
		if(this.isOpen === true){
			console.log( 'Cannot open a device that is already open!' );
			return;
		}
		
		this.device = new this.SPI.Spi('/dev/spidev0.0', {}, function(s){s.open();});
		
		this.isOpen = true;
	},
	handleSpiData: function(device, buf){	
		
		var data = ((buf[1]&3) << 8) + buf[2];
		
		// Let's exclude data readings that are 0 
		// and readings that are more than +/- 10% of the previous reading (indicates a spike we should ignore)
		if( data === 0 && Math.abs( ( data - this.resistances[this.resistances.length-1] ) / this.resistances[this.resistances.length-1] ) > this.options.ignore_data_beyond_pct ){
			// Let's discard this reading
			return -1;
		}		
		return data;		
	},
	storeSpiData: function( device, data ){			
		this.resistances[this.res_index] = data;		
	},
	setNextResistanceIndex: function(){
		this.res_index++;
		if(this.res_index > (this.options.resistances_to_keep -1) ){
			this.res_index = 0;
		}
	},
	read: function(){
		var self = this;
		var txbuf = new Buffer([1, (8 + this.options.channel) << 4, 0]);
		var rxbuf = new Buffer([ 0x00, 0x00, 0x00 ]);
		
		this.device.transfer( txbuf, rxbuf, function( device, buf ){ 
			var data = self.handleSpiData( device, buf ); 
			
			if( data > 0 ){
				self.storeSpiData( device, data );
				self.setNextResistanceIndex();
			}
		});			
	},
	getAverageData: function(){
		if( this.resistances.length === 0 ){
			return 0;
		}
		
		var sum = 0;
		for(var i = 0; i < this.resistances.length; i++){		
			sum += parseFloat(this.resistances[i]);
		}
		
		return sum / this.resistances.length;		
		
	},
	calculate_thermistor_resistance: function( average_raw ){
		console.log('average raw: ' + average_raw);
				
		var thermistor_resistance =  (1023 / average_raw) - 1;				
		thermistor_resistance = this.series_resistor / thermistor_resistance;		
						
		return thermistor_resistance;
	},
	steinhart: function( thermistor_resistance ){
		var steinhart = thermistor_resistance / this.thermistor.nominal_resistance;
		
		steinhart = Math.log( steinhart );
		steinhart = steinhart / this.thermistor.bcoefficient;
		steinhart += 1.0 / (this.thermistor.nominal_temp + 273.15);
		steinhart = 1.0 / steinhart;
		steinhart -= 273.15;
				
		return steinhart;
	},
	getAverageTemperature: function( average_resistance) {
		var thermistor_resistance = this.calculate_thermistor_resistance( average_resistance );
		var steinhart = this.steinhart( thermistor_resistance );		
		
		console.log('thermistor resistance: ' + thermistor_resistance);
		console.log('thermistor temperature: ' + Math.round( steinhart * 100 ) / 100);
		
		return steinhart;
	}
};
var DataLogger = {
	'options': {
		'logfile': '',
		'endpointUrl': 'http://192.168.1.141/dev/test.php',
		'timeout': 5000
	},	
	'txError': false,
	'data': [],
	init: function(logfile){
		this.options.logfile = logfile;		
		// Return this object to be used once init'd
		return this;
	},
	addDataPoint: function(model){
		this.data.push(model);
	},
	writeDataToFile : function(){	
		if( this.txError ) {
			return;
		}
		
		/* First load in the file contents */
		var self = this;
		fs.readFile(self.options.logfile, {'encoding': 'ascii'}, function (err, data) {
			if (err){
				throw err;
			}	
			
			try{		
				var fileData = [];
				
				if( data !== null && data !== '' ){
					fileData = JSON.parse(data);
				}
						
				var combinedData = fileData.concat(self.data);
				
				fs.writeFile(self.options.logfile, JSON.stringify(combinedData), { 'flag' : 'r+'}, function (err) {
					if (err){
						console.log(err);
						throw err;
					}
					
					self.data = [];
					console.log('It\'s saved!');
				});
			}catch( err ){
				//
			}	
		});
		
	},
	readDataFile : function(){		
		return fs.readFileSync(this.options.logfile, {'encoding': 'ascii'} );						
	},
	sendDataUpdate: function(){
		var self = this;
		
		if( self.data.length === 0 ){
			return;
		}
		
		var postData = {			
			payload: {
				value: JSON.stringify(self.data),
				content_type: 'application/json'
			}
		};
		
		needle.post( self.options.endpointUrl, postData, { timeout: self.options.timeout, multipart: true },			
			function (error, response, body) {				
				if (error || response.statusCode != 200) {
					/* We've got an error to deal with, let's set the error code till we get a successful send */
					self.txError = true;					
				}else{
					self.txError = false;
				}			
			}
		);
	}
};

var DataPointModel = {
	create: function(timestamp, data){
		return [timestamp, data];		
	}
};

// Configure our HTTP server to respond with Hello World to all requests.
var server = http.createServer(function (request, response) {	
	response.writeHead( 200, {
		'Content-Type': 'application/json'
	});
	
	response.end( DataLogger.readDataFile() );
});

// Listen on port 8000, IP defaults to 127.0.0.1
server.listen(8000);

DataLogger.init( '/home/pi/thermo-app/data/readings.data' );

/* Open the spi device */
spiADC.open();
/* Start reading the data from the spi device every XX ms */
setInterval( function(){ spiADC.read(); }, 33);
/* Let's get an average every XX ms */
setInterval( function(){ 
	var averageData = spiADC.getAverageData();
	var averageTemp = Math.round( spiADC.getAverageTemperature( averageData ) * 100 ) / 100;
	var model = DataPointModel.create( Math.round(new Date().getTime() / 1000), averageTemp );
	DataLogger.addDataPoint(model);
}, 2000);
/* Write the data we've captured to the data file and send our updates to the web app */
setInterval( function(){
	DataLogger.sendDataUpdate();
	DataLogger.writeDataToFile();	
}, 20000);