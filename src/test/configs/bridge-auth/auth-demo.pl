#!/usr/bin/env perl

use strict;
use warnings;
use IO::Socket::INET;

my $port = $ARGV[0] || 8124;
my $state = 'demo-state';
my $code = 'demo-code';
my $callback_url = "http://localhost:$port/callback?code=$code&state=$state";

my $server = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $port,
    Proto => 'tcp',
    Listen => 5,
    Reuse => 1,
) or die "listen failed on $port: $!\n";

my $open_status = system('xdg-open', $callback_url);
die "xdg-open failed with status $open_status\n" if $open_status != 0;

my $client = $server->accept() or die "accept failed: $!\n";
my $request_line = <$client>;

my $response = "auth demo ok\n";
print $client "HTTP/1.1 200 OK\r\n";
print $client "Content-Type: text/plain\r\n";
print $client "Content-Length: " . length($response) . "\r\n";
print $client "Connection: close\r\n\r\n";
print $client $response;
close $client;
close $server;

open my $out, '>', '/tmp/auth-demo-result.txt' or die "write failed: $!\n";
print {$out} $request_line;
close $out;

print $request_line;
